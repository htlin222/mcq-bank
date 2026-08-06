// 手把操作的端對端測試 —— 真的按下去,看畫面有沒有反應。
//
// Playwright 沒有手把 API,但不需要:輪詢器唯一的輸入來源是
// `navigator.getGamepads()`,用 addInitScript 把它換掉,整條路徑
// (rAF 輪詢 → 邊緣偵測 → 語意動作 → React state → DOM)就都是真的在跑,
// 只有最外層那顆塑膠是假的。震動也一併攔下來記錄,所以「送出時會震」是被
// 斷言的,不是被相信的。
//
// 跟 smoke.test.mjs 分開,因為斷言的性質不同:那支只問「整棵樹還活著嗎」,
// 這支問「按下 DPAD ↓ 之後選項有沒有被選起來」。兩支共用同一套 dist 與 API 樁。
//
// 桌機視窗而非 iPhone:接手把的人不會是在手機上,而且複習模式的雙欄版型
// (捲動目標的分支所在)只在 ≥md 存在。

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(HERE, '..', 'dist');
const REQUIRE = process.env.E2E_REQUIRE === '1';

// W3C 標準配置的索引。跟 lib/gamepad.ts 的 BUTTON_ACTIONS 是同一張表 —— 這裡
// 刻意重寫一次而不是 import:測試若跟著實作一起錯,就驗不到任何東西。
const BTN = {
  FACE_DOWN: 0,
  FACE_RIGHT: 1,
  FACE_LEFT: 2,
  FACE_UP: 3,
  L1: 4,
  R1: 5,
  L2: 6,
  R2: 7,
  START: 9,
  DPAD_UP: 12,
  DPAD_DOWN: 13,
  DPAD_LEFT: 14,
  DPAD_RIGHT: 15,
};

// 裝一支假的 8BitDo Pro 2。id 用真機回報的格式,順便驗到 gamepadName() 會不會
// 把後面那串 Vendor/Product 十六進位剝掉。
const FAKE_PAD = `(() => {
  const buttons = Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 }));
  const pad = {
    id: '8BitDo Pro 2 (STANDARD GAMEPAD Vendor: 2dc8 Product: 6006)',
    index: 0,
    connected: true,
    mapping: 'standard',
    buttons,
    axes: [0, 0, 0, 0],
    timestamp: 0,
    vibrationActuator: {
      playEffect: (type, params) => {
        window.__rumbles.push({ type, ...params });
        return Promise.resolve('complete');
      },
    },
  };
  window.__pad = pad;
  window.__rumbles = [];
  Object.defineProperty(navigator, 'getGamepads', {
    value: () => [pad],
    configurable: true,
    writable: true,
  });
  window.__press = (i, on) => {
    buttons[i].pressed = on;
    buttons[i].value = on ? 1 : 0;
    pad.timestamp = performance.now();
  };
})();`;

// 按一下就放開。壓住 120ms —— 遠超過一幀(才讀得到),又遠低於長按重複的
// 400ms 門檻(否則一次點擊會變成好幾次)。
async function tap(page, index, times = 1) {
  for (let n = 0; n < times; n++) {
    await page.evaluate((i) => window.__press(i, true), index);
    await page.waitForTimeout(120);
    await page.evaluate((i) => window.__press(i, false), index);
    await page.waitForTimeout(140);
  }
}

let browser;
let server;
let skipReason = null;

before(async () => {
  if (!fs.existsSync(path.join(DIST, 'index.html'))) {
    skipReason = `找不到 ${DIST}/index.html —— 先跑 pnpm --dir frontend build`;
    return;
  }
  let webkit;
  try {
    ({ webkit } = await import('playwright'));
  } catch {
    skipReason = '沒有 playwright(pnpm --dir frontend add -D playwright)';
    return;
  }
  try {
    browser = await webkit.launch();
  } catch (e) {
    skipReason = `WebKit 起不來(pnpm exec playwright install webkit):${e.message.split('\n')[0]}`;
    return;
  }
  server = await startServer({ dist: DIST });
});

after(async () => {
  if (server) await server.close();
  if (browser) await browser.close();
});

// 每個案例一份乾淨的 context:localStorage(版型、震動偏好)與作答狀態都會
// 互相汙染。serviceWorkers: 'block' —— 正式建置會註冊 SW,讓它插手快取會把
// 失敗變成看起來像時序問題的東西。
async function open(t, route) {
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    serviceWorkers: 'block',
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.stack || e.message));
  await ctx.route('**/*', (r) =>
    r.request().url().startsWith(server.origin) ? r.continue() : r.abort(),
  );
  await page.addInitScript(FAKE_PAD);
  await page.goto(server.origin + route, {
    waitUntil: 'domcontentloaded',
    timeout: 30_000,
  });
  await page.waitForTimeout(2_500);
  t.after(async () => {
    await ctx.close();
  });
  return { page, errors };
}

function guard(t) {
  if (!skipReason) return false;
  if (REQUIRE) assert.fail(`E2E_REQUIRE=1 但無法執行:${skipReason}`);
  t.skip(skipReason);
  return true;
}

test('手把接上時 FAB 出現,並報出型號', async (t) => {
  if (guard(t)) return;
  const { page, errors } = await open(t, '/q/113-050');

  const fab = page.getByRole('button', { name: '手把操作說明' });
  assert.equal(await fab.count(), 1, '偵測到手把時應該要有說明 FAB');

  // 連上的提示 —— 使用者判斷「網頁看到手把了」的唯一信號。
  const body = await page.evaluate(() => document.body.innerText);
  assert.ok(
    body.includes('已連線'),
    `應該跳出連線提示;實際:${body.slice(0, 300)}`,
  );
  assert.ok(
    body.includes('8BitDo Pro 2'),
    'gamepadName() 應該剝掉 Vendor/Product 那一串,只留型號',
  );

  await fab.click();
  const panel = await page.evaluate(() => document.body.innerText);
  assert.ok(panel.includes('手把操作'), '面板標題');
  assert.ok(panel.includes('選擇選項'), '面板要列出當前頁的按鍵表');
  assert.ok(panel.includes('送出答案時震動'), '面板要有震動開關');
  assert.ok(
    !panel.includes('不是標準配置'),
    'mapping 是 standard,不該顯示配置警告',
  );

  assert.deepEqual(errors, [], '不該有未捕捉例外');
});

test('沒接手把時 FAB 不出現', async (t) => {
  if (guard(t)) return;
  // 唯一不裝假手把的案例:證明 FAB 是被「有沒有手把」控制的,而不是永遠都在。
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    serviceWorkers: 'block',
  });
  t.after(async () => {
    await ctx.close();
  });
  const page = await ctx.newPage();
  await ctx.route('**/*', (r) =>
    r.request().url().startsWith(server.origin) ? r.continue() : r.abort(),
  );
  await page.addInitScript(
    `Object.defineProperty(navigator, 'getGamepads', { value: () => [], configurable: true });`,
  );
  await page.goto(server.origin + '/q/113-050', {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForTimeout(2_500);

  assert.equal(
    await page.getByRole('button', { name: '手把操作說明' }).count(),
    0,
    '沒手把就不該有這顆按鈕',
  );
});

test('DPAD ↑↓ 選選項、←→ 調信心度、FACE ◀ 直接看答案', async (t) => {
  if (guard(t)) return;
  const { page, errors } = await open(t, '/q/113-050');

  // 還沒選:信心度那一列不存在(只在 !revealed && chosen 時渲染)。
  assert.ok(
    !(await page.evaluate(() => document.body.innerText)).includes('作答信心'),
    '一開始不該有信心度',
  );

  await tap(page, BTN.DPAD_DOWN); // 沒選過 → ↓ 落在 A
  assert.ok(
    (await page.evaluate(() => document.body.innerText)).includes('作答信心'),
    'DPAD ↓ 之後應該選中一個選項,信心度那一列才會出現',
  );

  // 預設是 普通(2);→ 一下應該變 有把握(3)。
  // 頁面上還有別的 aria-pressed(雙欄/分頁的檢視切換,純圖示無文字),所以
  // 只挑信心度那三顆的文字。
  const LEVELS = ['猜', '普通', '有把握'];
  const pressed = () =>
    page.$$eval('button[aria-pressed="true"]', (els) =>
      els.map((e) => e.textContent.trim()),
    ).then((all) => all.filter((t) => LEVELS.includes(t)));
  assert.deepEqual(await pressed(), ['普通'], '預設信心度');
  await tap(page, BTN.DPAD_RIGHT);
  assert.deepEqual(await pressed(), ['有把握'], 'DPAD → 往上調一級');
  // 到頂了就該停住,不能繞回「猜」—— 那會記錄成相反的意思。
  await tap(page, BTN.DPAD_RIGHT);
  assert.deepEqual(await pressed(), ['有把握'], '到頂夾住,不繞回');
  await tap(page, BTN.DPAD_LEFT, 2);
  assert.deepEqual(await pressed(), ['猜'], 'DPAD ← 往下調');
  await tap(page, BTN.DPAD_LEFT);
  assert.deepEqual(await pressed(), ['猜'], '到底也夾住');

  // FACE ◀ = 略過 / 直接看答案。揭曉文案會說出剛剛選的是哪個字母 ——
  // 正解是 B,所以「你選 A」同時驗到了游標確實停在第一個選項。
  await tap(page, BTN.FACE_LEFT);
  const after = await page.evaluate(() => document.body.innerText);
  assert.ok(
    after.includes('你選 A') && after.includes('正解 B'),
    `FACE ◀ 應該揭曉答案且保留選擇;實際:${after.slice(0, 400)}`,
  );

  assert.deepEqual(errors, [], '不該有未捕捉例外');
});

test('FACE ▼ 送出答案,並且震動', async (t) => {
  if (guard(t)) return;
  const { page, errors } = await open(t, '/q/113-050');

  await tap(page, BTN.DPAD_DOWN, 2); // A → B,正解
  assert.deepEqual(await page.evaluate(() => window.__rumbles), [], '選選項不該震');

  await tap(page, BTN.FACE_DOWN);
  await page.waitForTimeout(600); // 等 POST 回來 + 對錯那一段震動

  const text = await page.evaluate(() => document.body.innerText);
  assert.ok(text.includes('答對了'), `應該送出並判定答對;實際:${text.slice(0, 300)}`);

  const rumbles = await page.evaluate(() => window.__rumbles);
  assert.ok(rumbles.length >= 2, `送出應該震兩段(按下 + 對錯),實際 ${rumbles.length} 段`);
  assert.equal(rumbles[0].type, 'dual-rumble');
  assert.equal(rumbles[0].duration, 60, '第一段是按下的 tap');
  // 答對是兩下 40ms 輕快;答錯會是一段 180ms 重的。
  assert.ok(
    rumbles.slice(1).every((r) => r.duration === 40),
    `答對的回饋應該是兩下 40ms;實際:${JSON.stringify(rumbles.slice(1))}`,
  );

  assert.deepEqual(errors, [], '不該有未捕捉例外');
});

test('震動可以關掉,關掉之後送出不再震', async (t) => {
  if (guard(t)) return;
  const { page } = await open(t, '/q/113-050');

  await page.getByRole('button', { name: '手把操作說明' }).click();
  await page.getByLabel('送出答案時震動').uncheck();
  await page.keyboard.press('Escape');

  await tap(page, BTN.DPAD_DOWN, 2);
  await tap(page, BTN.FACE_DOWN);
  await page.waitForTimeout(600);

  assert.ok(
    (await page.evaluate(() => document.body.innerText)).includes('答對了'),
    '關震動不該影響作答本身',
  );
  assert.deepEqual(
    await page.evaluate(() => window.__rumbles),
    [],
    '關掉之後一段都不該震',
  );
});

test('L1 跳上一題', async (t) => {
  if (guard(t)) return;
  const { page, errors } = await open(t, '/q/113-050');
  assert.deepEqual(errors, [], '起點就不該有例外');

  // 用 L1 而不是 R1:113-050 是 fixture 那一年的最後一題,navNext 是空的,
  // 所以 R1 什麼都不做 —— 那是正確行為,不是可以拿來驗導覽的案例。
  await tap(page, BTN.L1);
  await page.waitForTimeout(800);
  const afterPrev = new URL(page.url()).pathname;
  assert.equal(afterPrev, '/q/113-049', `L1 應該退到前一題;實際停在 ${afterPrev}`);
  // 落點那一題沒有 fixture(樁回 {}),所以只驗路由,不繼續在那頁按下去。
});

test('START 回年度列表,而且不會被新頁面再吃一次', async (t) => {
  if (guard(t)) return;
  const { page, errors } = await open(t, '/q/113-050');

  // 這一按同時驗兩件事。換頁時舊路由的訂閱先卸載、新路由才掛上,中間輪詢器
  // 會停一瞬間;而一次真實按壓長達 120ms,橫跨得過那個縫。若重啟輪詢時把
  // 「還按著的鍵」當成新按壓,年度列表的 START(回 /review)就會吃到同一下,
  // 使用者按一次卻穿過兩層。修掉之前這裡真的會停在 /review。
  await tap(page, BTN.START);
  await page.waitForTimeout(1_200);
  assert.equal(
    new URL(page.url()).pathname,
    '/year/113',
    'START 應該停在年度列表,不該穿過去',
  );

  assert.deepEqual(errors, [], '不該有未捕捉例外');
});

test('年度列表:DPAD ↓ 移動游標,FACE ▼ 進入該題', async (t) => {
  if (guard(t)) return;
  const { page, errors } = await open(t, '/year/113');

  // 先把畫面上的順序讀下來,再用它當預期值 —— 不寫死題號,篩選預設值改了
  // 也不會假性失敗。
  const hrefs = await page.$$eval('ol li a', (as) =>
    as.map((a) => new URL(a.href).pathname),
  );
  assert.ok(hrefs.length >= 2, '年度列表至少要有兩列才驗得了游標');

  // 游標從 0 開始,↓ 一次到第二列。
  await tap(page, BTN.DPAD_DOWN);
  const ringed = await page.$$eval('ol li a', (as) =>
    as.findIndex((a) => a.className.includes('ring-2')),
  );
  assert.equal(ringed, 1, '游標框應該落在第二列');
  assert.deepEqual(errors, [], '列表本身不該有未捕捉例外');

  await tap(page, BTN.FACE_DOWN);
  await page.waitForTimeout(800);
  assert.equal(
    new URL(page.url()).pathname,
    hrefs[1],
    'FACE ▼ 應該進入游標所在那一題',
  );
  // 落點那一題沒有 fixture(樁會回 {}),所以只驗路由,不驗它渲染成什麼。
});

test('長按 DPAD ↓ 會連續移動,放開就停', async (t) => {
  if (guard(t)) return;
  const { page } = await open(t, '/year/113');

  const cursorAt = () =>
    page.$$eval('ol li a', (as) =>
      as.findIndex((a) => a.className.includes('ring-2')),
    );

  // 壓住 1 秒:第一下 + 400ms 之後每 120ms 一次 ≈ 1 + 5 次。
  await page.evaluate((i) => window.__press(i, true), BTN.DPAD_DOWN);
  await page.waitForTimeout(1000);
  await page.evaluate((i) => window.__press(i, false), BTN.DPAD_DOWN);
  await page.waitForTimeout(200);

  const moved = await cursorAt();
  assert.ok(
    moved >= 4 && moved <= 8,
    `長按一秒應該移動 6 格上下(容忍畫面更新抖動);實際 ${moved}`,
  );

  // 放開之後不能再自己走。
  await page.waitForTimeout(500);
  assert.equal(await cursorAt(), moved, '放開後游標應該停住');
});

test('非標準配置的手把會被警告,而不是靜默錯位', async (t) => {
  if (guard(t)) return;
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    serviceWorkers: 'block',
  });
  t.after(async () => {
    await ctx.close();
  });
  const page = await ctx.newPage();
  await ctx.route('**/*', (r) =>
    r.request().url().startsWith(server.origin) ? r.continue() : r.abort(),
  );
  // 8BitDo 切到 S/D/M 模式時的樣子:mapping 不是 'standard',索引對不上。
  await page.addInitScript(FAKE_PAD);
  await page.addInitScript(`window.addEventListener('DOMContentLoaded', () => {});`);
  await page.addInitScript(`(() => {
    const orig = navigator.getGamepads;
    Object.defineProperty(navigator, 'getGamepads', {
      value: () => orig().map((p) => (p ? Object.assign(Object.create(Object.getPrototypeOf(p)), p, { mapping: '' }) : p)),
      configurable: true,
    });
  })();`);
  await page.goto(server.origin + '/q/113-050', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2_500);

  await page.getByRole('button', { name: '手把操作說明' }).click();
  const text = await page.evaluate(() => document.body.innerText);
  assert.ok(
    text.includes('不是標準配置') && text.includes('X 模式'),
    `應該警告配置對不上並指出切到 X 模式;實際:${text.slice(0, 400)}`,
  );
});

// 交卷要先問過,而有未答題時要問兩次。
//
// 回報的原話是「有時候不小心就交卷出去了」。舊版:全部答完 → 一聲不響直接送出;
// 有未答題 → 一個原生 `confirm()`。交卷鈕就在計時列右上角、緊鄰「暫停」,而手機
// 的拇指正好落在那一帶 —— 這是這一頁唯一一個單擊即不可逆的動作。
//
// ⚠️ **這支的每一條都先斷言「對話框真的開起來了」再斷言「沒有送出」。**
// 「沒有發出 finish 請求」是負面斷言,在**交卷鈕根本點不到**時也會成立 ——
// 選擇器一腐爛就退化成空掃的綠燈,跟 users_online.json 空 fixture 同一種。
//
//   pnpm test:webkit

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(HERE, '..', 'dist');
const REQUIRE = process.env.E2E_REQUIRE === '1';

const SID = 'e2e-1';
const STATE = JSON.parse(
  fs.readFileSync(path.join(HERE, 'fixtures', `exam_${SID}_state.json`), 'utf8'),
);

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

/**
 * `running_since` 是絕對時間戳,靜態 fixture 給什麼都會過期(給過去的時間,client
 * 會算出已超過上限而**自動交卷** —— 那條路徑刻意不經過對話框,於是整支測試會在
 * 一個跟功能無關的地方紅)。所以「現在」在請求當下才注入。
 */
async function setup(t, { allAnswered = false, pad = false } = {}) {
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    serviceWorkers: 'block',
  });
  const calls = { bulk: 0, finish: 0 };
  const questions = allAnswered
    ? STATE.questions.map((q) => ({ ...q, chosen: q.chosen ?? 'A' }))
    : STATE.questions;

  await ctx.route('**/api/exam/**', async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    const json = (body) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify(body),
      });
    if (p.endsWith('/state')) return json({ ...STATE, questions, running_since: Date.now() });
    if (p.endsWith('/answers') && req.method() === 'PUT') {
      calls.bulk++;
      return json({ changed: 0, unchanged: questions.length, unknown: 0, invalid: 0 });
    }
    if (p.endsWith('/finish')) {
      calls.finish++;
      return json({ score: 20, duration_sec: 720 });
    }
    // 其餘交給 fixture 伺服器 —— 交卷後會落在成績頁,而回一律 `{}` 會讓那一頁
    // 自己炸掉(`t.answers.length`),看起來像交卷流程的錯。
    return route.continue();
  });

  const page = await ctx.newPage();
  if (pad) await page.addInitScript(FAKE_PAD);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // 原生 confirm 已經不該再出現。真的冒出來就讓它逾時而不是默默接受 ——
  // 接受等於把「退回舊版」變成綠燈。
  page.on('dialog', () => {});
  await page.goto(`${server.origin}/exam/${SID}`, { waitUntil: 'domcontentloaded' });

  const submitBtn = page.locator('header button', { hasText: '交卷' }).first();
  await submitBtn.waitFor({ timeout: 20_000 });
  return { ctx, page, calls, errors, submitBtn, dialog: page.locator('[role="dialog"]') };
}

// 一支標準配置的假手把,同 gamepad.test.mjs。索引刻意重寫一次而不是從
// lib/gamepad.ts import —— 測試跟著實作一起錯就驗不到東西。
const BTN = { FACE_RIGHT: 1, START: 9 };
const FAKE_PAD = `(() => {
  const buttons = Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 }));
  const pad = {
    id: '8BitDo Pro 2 (STANDARD GAMEPAD Vendor: 2dc8 Product: 6006)',
    index: 0, connected: true, mapping: 'standard',
    buttons, axes: [0, 0, 0, 0], timestamp: 0,
  };
  Object.defineProperty(navigator, 'getGamepads', {
    value: () => [pad], configurable: true, writable: true,
  });
  window.__press = (i, on) => {
    buttons[i].pressed = on;
    buttons[i].value = on ? 1 : 0;
    pad.timestamp = performance.now();
  };
})();`;

// 壓住 120ms —— 遠超過一幀(才讀得到),又遠低於長按重複的 400ms 門檻。
async function tap(page, index) {
  await page.evaluate((i) => window.__press(i, true), index);
  await page.waitForTimeout(120);
  await page.evaluate((i) => window.__press(i, false), index);
  await page.waitForTimeout(200);
}

function guard(t) {
  if (!skipReason) return false;
  if (REQUIRE) assert.fail(`E2E_REQUIRE=1 但無法執行:${skipReason}`);
  t.skip(skipReason);
  return true;
}

test('有未答題:交卷要按三下(交卷 → 仍要交卷 → 確定交卷)', async (t) => {
  if (guard(t)) return;
  const { ctx, page, calls, errors, submitBtn, dialog } = await setup(t);
  try {
    await submitBtn.click();

    // ① 對話框開起來,而且**還沒送出任何東西**。
    await dialog.waitFor({ timeout: 10_000 });
    const first = await dialog.innerText();
    assert.match(first, /已作答\s*33\s*\/\s*100/, `摘要不對:${first.slice(0, 120)}`);
    assert.match(first, /還有\s*67\s*題空白/, '沒有把未答題數講出來');
    assert.match(first, /已標記待檢查\s*14\s*題/, '標記題那一區沒有出現');
    assert.equal(calls.finish, 0, '對話框都還沒回答就交卷了');

    // ② 第二段。主按鈕是「回去作答」,交卷那顆刻意低調 —— 這裡點的是低調的那顆。
    await dialog.getByRole('button', { name: '仍要交卷', exact: true }).click();
    await dialog.getByRole('button', { name: '確定交卷', exact: true }).waitFor({ timeout: 5_000 });
    const second = await dialog.innerText();
    assert.match(second, /這\s*67\s*題會以\s*0\s*分計算/, `第二段的標題不對:${second.slice(0, 120)}`);
    assert.equal(calls.finish, 0, '第二段還沒確認就交卷了');

    // ③ 真的送出。
    await dialog.getByRole('button', { name: '確定交卷', exact: true }).click();
    await page.waitForURL(`**/exam/${SID}/result`, { timeout: 20_000 });
    assert.equal(calls.finish, 1, 'finish 應該剛好一趟');
    assert.equal(calls.bulk, 1, '批次補送應該剛好一趟');
    assert.deepEqual(errors, []);
  } finally {
    await ctx.close();
  }
});

test('全部答完:一段確認就夠(不硬要人多按一下)', async (t) => {
  if (guard(t)) return;
  const { ctx, page, calls, errors, submitBtn, dialog } = await setup(t, { allAnswered: true });
  try {
    await submitBtn.click();
    await dialog.waitFor({ timeout: 10_000 });
    const text = await dialog.innerText();
    assert.match(text, /已作答\s*100\s*\/\s*100/, `摘要不對:${text.slice(0, 120)}`);
    assert.ok(!/空白/.test(text), '全部答完了還在講空白題');
    assert.equal(
      await dialog.getByRole('button', { name: '仍要交卷', exact: true }).count(),
      0,
      '全部答完不該還有第二段',
    );
    assert.equal(calls.finish, 0, '對話框都還沒回答就交卷了');

    await dialog.getByRole('button', { name: '確定交卷', exact: true }).click();
    await page.waitForURL(`**/exam/${SID}/result`, { timeout: 20_000 });
    assert.equal(calls.finish, 1, 'finish 應該剛好一趟');
    assert.deepEqual(errors, []);
  } finally {
    await ctx.close();
  }
});

test('點對話框裡的題號會回去作答,而且不交卷', async (t) => {
  if (guard(t)) return;
  const { ctx, page, calls, errors, submitBtn, dialog } = await setup(t);
  try {
    // 對照組:先確認現在**不在**第 5 題,否則「跳過去了」恆真。
    // (續考落點是第一題未作答 = 第 1 題,見 lib/examResume.ts)
    const heading = page.locator('main').getByText(/第 \d+ 題 \/ 100/).first();
    await heading.waitFor({ timeout: 10_000 });
    const before = await heading.innerText();
    assert.ok(!/第 5 題/.test(before), `一開始就在第 5 題了,這條驗不到東西:${before}`);

    await submitBtn.click();
    await dialog.waitFor({ timeout: 10_000 });
    await dialog.getByRole('button', { name: '5', exact: true }).click();

    await dialog.waitFor({ state: 'detached', timeout: 5_000 });
    assert.match(await heading.innerText(), /第 5 題/, '點了題號卻沒有跳過去');
    assert.equal(calls.finish, 0, '點題號回去作答不該送出考卷');
    assert.deepEqual(errors, []);
  } finally {
    await ctx.close();
  }
});

test('Esc 關掉對話框,考卷還在', async (t) => {
  if (guard(t)) return;
  const { ctx, page, calls, errors, submitBtn, dialog } = await setup(t);
  try {
    await submitBtn.click();
    await dialog.waitFor({ timeout: 10_000 });
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached', timeout: 5_000 });
    assert.equal(calls.finish, 0, 'Esc 之後居然交卷了');
    assert.ok(page.url().endsWith(`/exam/${SID}`), `不該離開作答頁:${page.url()}`);
    assert.deepEqual(errors, []);
  } finally {
    await ctx.close();
  }
});

test('焦點落在安全的那一顆 —— 一個 Enter 不會把考卷送出去', async (t) => {
  if (guard(t)) return;
  const { ctx, page, calls, errors, submitBtn, dialog } = await setup(t);
  try {
    await submitBtn.click();
    await dialog.waitFor({ timeout: 10_000 });
    // 對照組:真的有東西被聚焦(沒有的話 activeElement 是 body,底下恆真)。
    const focused = await page.evaluate(() => document.activeElement?.textContent?.trim() ?? '');
    assert.ok(focused.length > 0, '對話框開起來卻沒有任何東西拿到焦點');
    assert.equal(focused, '回去作答', `預設焦點在「${focused}」上 —— 這顆會直接推進交卷流程`);

    await page.keyboard.press('Enter');
    await page.waitForTimeout(500);
    assert.equal(calls.finish, 0, '按一下 Enter 就交卷了');
    assert.deepEqual(errors, []);
  } finally {
    await ctx.close();
  }
});

test('手把:START 開對話框、再按才推進,FACE ▶ 退回去', async (t) => {
  if (guard(t)) return;
  const { ctx, page, calls, errors, dialog } = await setup(t, { pad: true });
  try {
    // ① START 只是打開對話框。舊版這一下就把考卷送出去了。
    await tap(page, BTN.START);
    await dialog.waitFor({ timeout: 10_000 });
    assert.equal(calls.finish, 0, '一下 START 就交卷了');

    // 鍵位說明畫在對話框裡面 —— GamepadFab 是 z-30,被這裡的 z-50 遮罩蓋住,
    // 寫進那份 hints 等於寫在看不見的地方。
    assert.match(await dialog.innerText(), /START \/ FACE ▼/, '對話框裡沒有手把鍵位說明');

    // ② 第二下推進到最終確認,仍然沒有送出。
    await tap(page, BTN.START);
    await dialog.getByRole('button', { name: '確定交卷', exact: true }).waitFor({ timeout: 5_000 });
    assert.equal(calls.finish, 0, '第二下 START 就交卷了');

    // ③ FACE ▶ 退回第一段(位置而非廠商字母:右鍵 = 取消)。
    await tap(page, BTN.FACE_RIGHT);
    await dialog.getByRole('button', { name: '仍要交卷', exact: true }).waitFor({ timeout: 5_000 });
    assert.equal(calls.finish, 0);

    // ④ 走完兩段才真的送出。
    await tap(page, BTN.START);
    await tap(page, BTN.START);
    await page.waitForURL(`**/exam/${SID}/result`, { timeout: 20_000 });
    assert.equal(calls.finish, 1, 'finish 應該剛好一趟');
    assert.deepEqual(errors, []);
  } finally {
    await ctx.close();
  }
});

// 首頁的抹片輪播卡:手動翻頁、自動輪播與它的暫停、全螢幕螢幕保護。
//
// **每一條都先斷言「東西找得到」再斷言行為。** 「按了之後沒有換」「暫停之後
// 沒有換」都是負面斷言 —— 在卡片根本沒畫出來時同樣成立,那就是這個 repo 踩過
// 好幾次的假綠(users_online.json 空 fixture、gamepad 收藏那條)。
//
// 期望值一律從 fixture 推出來,不寫死字串 —— 同 gamepad.test.mjs 的教訓:
// fixture 是好幾支測試共用的素材,寫死的話別人動它就會紅在無關的地方。
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

const FIXTURE = JSON.parse(
  fs.readFileSync(path.join(HERE, 'fixtures', 'smear_gallery.json'), 'utf8'),
);
const ITEMS = FIXTURE.items;

// 第一筆的共筆詳解全文 —— 全螢幕畫的是它,不是卡片那 220 字的摘要。
// 期望值由 fixture 推出來(同上面的理由),而且**刻意取一段落在摘要截斷點之後
// 的文字**:用摘要裡也有的字去斷言的話,「全文沒載到、退回摘要」照樣會綠。
const DX = JSON.parse(
  fs.readFileSync(
    path.join(HERE, 'fixtures', `smear_dx_${ITEMS[0].dx_id}.json`),
    'utf8',
  ),
);

function plainText(node, out = []) {
  if (Array.isArray(node)) node.forEach((n) => plainText(n, out));
  else if (node && typeof node === 'object') {
    if (node.type === 'text' && node.text) out.push(node.text);
    Object.values(node).forEach((v) => plainText(v, out));
  }
  return out;
}
// ⚠️ 比對目標必須是**單一一個文字節點**,不能是把所有節點串起來之後切一段:
// 串接時節點之間補的空白在 DOM 的 textContent 裡並不存在,切到跨節點的位置就
// 永遠比不到 —— 而那會紅在一個看起來像「全文沒載到」的地方。實際踩到。
const NOTE_NODES = plainText(JSON.parse(DX.note.content_json));
const PREVIEW = ITEMS[0].note_preview;
const BEYOND_PREVIEW = NOTE_NODES.find(
  (t) => t.trim().length >= 12 && !PREVIEW.includes(t.trim()),
)?.trim();
if (!BEYOND_PREVIEW) throw new Error('fixture 裡找不到「只有全文才有」的段落');

// 自動輪播是 20 秒(lib/smearGallery.ts 的 AUTO_ADVANCE_MS)。等 26 秒留六秒
// 餘裕 —— 寫死「剛好 20 秒」在忙碌的 CI 上會假紅。
//
// ⚠️ 這幾條因此是整個套件裡最慢的。**不要為了跑快一點把間隔改小** —— 那個常數
// 回答的是「一張圖該停多久才讀得完」(全螢幕畫的是 1363 字的詳解全文),不是
// 「測試要跑多久」。
const WAIT_MS = 26_000;

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
    browser = await webkit.launch();
  } catch (e) {
    skipReason = `WebKit 起不來:${e.message}`;
    if (REQUIRE) throw e;
    return;
  }
  server = await startServer({ dist: DIST });
});

after(async () => {
  await browser?.close();
  await server?.close();
});

async function open(t, { paused = false } = {}) {
  if (skipReason) {
    t.skip(skipReason);
    return null;
  }
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    // 這一頁不需要 SW,而讓它上線會讓請求數與快取狀態變得不可預測。
    serviceWorkers: 'block',
  });
  const page = await ctx.newPage();
  if (paused) {
    await page.addInitScript(() => {
      try {
        localStorage.setItem('smear-gallery-paused', '1');
      } catch {}
    });
  }
  await page.goto(`${server.origin}/`);
  await page.waitForSelector('[data-smear-gallery]');
  return { ctx, page };
}

/** 現在畫的是哪一張 —— 圖片上的 data 屬性就是 smear_questions.id。 */
const currentId = (page) =>
  page.getAttribute('[data-smear-gallery] [data-gallery-image]', 'data-gallery-image');

test('卡片畫出第一筆的診斷名、詳解摘要與來源', async (t) => {
  const opened = await open(t);
  if (!opened) return;
  const { ctx, page } = opened;

  const first = ITEMS[0];
  assert.equal(await currentId(page), first.id, '第一張應該是 fixture 的第一筆');

  const card = page.locator('[data-smear-gallery]');
  await assert.doesNotReject(
    card.getByRole('heading', { name: first.canonical_long, exact: true }).waitFor({ timeout: 3000 }),
    '診斷名沒有畫出來 —— 這張卡的整個用途就是把答案講出來',
  );

  // 共筆詳解摘要:比對前 20 字就夠(畫面上是 line-clamp-3,但 DOM 裡是全文)。
  const text = await card.innerText();
  assert.ok(
    text.includes(first.note_preview.slice(0, 20)),
    '詳解摘要沒有出現在卡片上',
  );
  assert.ok(
    await card.locator(`a[href="${first.source_url}"]`).count(),
    '來源連結沒有畫出來',
  );
  assert.ok(
    await card.locator(`a[href="/smear/dx/${first.dx_id}"]`).count(),
    '「看完整診斷」連結沒有指向這一筆的 dx',
  );

  await ctx.close();
});

test('「下一張」真的換一張,「上一張」回得來', async (t) => {
  const opened = await open(t, { paused: true }); // 暫停,免得自動輪播插進來
  if (!opened) return;
  const { ctx, page } = opened;

  const before0 = await currentId(page);
  await page.getByRole('button', { name: '下一張' }).first().click();
  await page.waitForFunction(
    (prev) =>
      document
        .querySelector('[data-smear-gallery] [data-gallery-image]')
        ?.getAttribute('data-gallery-image') !== prev,
    before0,
    { timeout: 3000 },
  );
  const after0 = await currentId(page);
  assert.notEqual(after0, before0);
  assert.equal(after0, ITEMS[1].id);

  // 說明也要跟著換 —— 只換圖不換說明是這種卡片最尷尬的壞法(答案配錯圖)。
  const card = page.locator('[data-smear-gallery]');
  await assert.doesNotReject(
    card.getByRole('heading', { name: ITEMS[1].canonical_long, exact: true }).waitFor({ timeout: 3000 }),
    '換了圖但說明還停在上一張',
  );

  await page.getByRole('button', { name: '上一張' }).first().click();
  await page.waitForFunction(
    (want) =>
      document
        .querySelector('[data-smear-gallery] [data-gallery-image]')
        ?.getAttribute('data-gallery-image') === want,
    before0,
    { timeout: 3000 },
  );

  await ctx.close();
});

test('自動輪播會自己換,而暫停之後不會', async (t) => {
  const opened = await open(t);
  if (!opened) return;
  const { ctx, page } = opened;

  // ⚠️ 指標停在卡片上會暫停輪播(那是刻意的),所以先把它挪開。少了這行,
  // 下面那條會紅在一個跟自動輪播無關的地方。
  await page.mouse.move(5, 5);

  const start = await currentId(page);
  await page.waitForFunction(
    (prev) =>
      document
        .querySelector('[data-smear-gallery] [data-gallery-image]')
        ?.getAttribute('data-gallery-image') !== prev,
    start,
    { timeout: WAIT_MS },
  );
  const auto = await currentId(page);
  assert.notEqual(auto, start, '等了十幾秒都沒有自己換 —— 自動輪播沒接上');

  // 這是對照組:上面證明了它真的會動,下面「按了暫停就不動」才有話語權。
  await page.getByRole('button', { name: '暫停自動輪播' }).first().click();
  await page.mouse.move(5, 5);
  const held = await currentId(page);
  await page.waitForTimeout(WAIT_MS);
  assert.equal(await currentId(page), held, '按了暫停還是自己換掉了');

  // 暫停鈕按下去之後要變成「開始」—— 同一顆鍵換了意思,標籤沒跟著換的話,
  // 使用者不知道再按一下會發生什麼。
  assert.ok(
    await page.getByRole('button', { name: '開始自動輪播' }).count(),
    '暫停之後按鈕的標籤沒有跟著換',
  );

  await ctx.close();
});

test('全螢幕螢幕保護開得起來、關得掉,而且看的是同一張', async (t) => {
  const opened = await open(t, { paused: true });
  if (!opened) return;
  const { ctx, page } = opened;

  const id = await currentId(page);
  await page.getByRole('button', { name: '全螢幕輪播' }).first().click();

  const saver = page.locator('[data-smear-screensaver]');
  await saver.waitFor({ timeout: 3000 });
  assert.equal(
    await saver.locator('[data-gallery-image]').getAttribute('data-gallery-image'),
    id,
    '進全螢幕之後看的不是同一張 —— 輪播狀態應該由卡片持有',
  );

  // 全螢幕裡也要看得到說明,否則它只是一張大圖。
  const item = ITEMS.find((i) => i.id === id);
  await assert.doesNotReject(
    saver.getByRole('heading', { name: item.canonical_long, exact: true }).waitFor({ timeout: 3000 }),
    '全螢幕裡沒有說明',
  );

  // Esc 要自己接:requestFullscreen() 在 iOS Safari 之類會被拒絕,那時瀏覽器
  // 不會替我們處理 Esc,而它是唯一沒有滑鼠的離開方式。
  await page.keyboard.press('Escape');
  await saver.waitFor({ state: 'detached', timeout: 3000 });

  await ctx.close();
});

test('全螢幕畫的是共筆詳解全文,不是卡片那 220 字的摘要', async (t) => {
  const opened = await open(t, { paused: true });
  if (!opened) return;
  const { ctx, page } = opened;

  // 對照組:卡片上只有摘要,截斷點之後的文字**不該**在那裡。少了這半段,
  // 下面那條在「卡片本來就畫了全文」時也會綠,等於什麼都沒驗到。
  const cardText = await page.locator('[data-smear-gallery]').innerText();
  assert.ok(
    !cardText.includes(BEYOND_PREVIEW),
    '卡片上不該出現摘要截斷點之後的文字',
  );

  await page.getByRole('button', { name: '全螢幕輪播' }).first().click();
  const saver = page.locator('[data-smear-screensaver]');
  await saver.waitFor({ timeout: 3000 });

  await page.waitForFunction(
    (needle) =>
      document
        .querySelector('[data-smear-screensaver]')
        ?.textContent?.includes(needle) ?? false,
    BEYOND_PREVIEW,
    { timeout: 5000 },
  );

  // 結構要留著 —— 整篇壓平成純文字的話標題會黏進內文,愈長愈難讀。
  assert.ok(
    await saver.locator('.tiptap :is(h1, h2, h3)').count(),
    '全文應該走 StaticContent 保留標題,不是一段壓平的純文字',
  );

  await ctx.close();
});

test('自動輪播時顯示秒數倒數,而且真的在往下走', async (t) => {
  const opened = await open(t);
  if (!opened) return;
  const { ctx, page } = opened;
  await page.mouse.move(5, 5);

  const readCountdown = () =>
    page.evaluate(() => {
      const el = [...document.querySelectorAll('[data-smear-gallery] span')].find(
        (s) => /^\d+s$/.test(s.textContent.trim()),
      );
      return el ? Number(el.textContent.trim().replace('s', '')) : null;
    });

  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('[data-smear-gallery] span')].some((s) =>
        /^\d+s$/.test(s.textContent.trim()),
      ),
    undefined,
    { timeout: 3000 },
  );
  const first = await readCountdown();
  assert.ok(first !== null && first > 0 && first <= 20, `倒數起始值不合理:${first}`);

  await page.waitForTimeout(2500);
  const later = await readCountdown();
  assert.ok(later !== null && later < first, `倒數沒有往下走:${first} → ${later}`);

  // 暫停之後倒數要消失 —— 停著不動的倒數是假的資訊。
  await page.getByRole('button', { name: '暫停自動輪播' }).first().click();
  await page.waitForFunction(
    () =>
      ![...document.querySelectorAll('[data-smear-gallery] span')].some((s) =>
        /^\d+s$/.test(s.textContent.trim()),
      ),
    undefined,
    { timeout: 3000 },
  );

  await ctx.close();
});

test('全螢幕裡也看得到倒數 —— 卡片的 hover 暫停不准漏進來', async (t) => {
  // ⚠️ 這條守的是一個實際踩到的坑:React 的 portal 事件沿 **React 樹**冒泡,
  // 所以指標在全螢幕 overlay 裡的任何位置都會觸發卡片那顆 <section> 的
  // onMouseEnter,於是自動輪播在螢幕保護裡一次都不會跑 —— 而畫面上唯一的線索
  // 就是倒數不見了。
  const opened = await open(t);
  if (!opened) return;
  const { ctx, page } = opened;

  await page.getByRole('button', { name: '全螢幕輪播' }).first().click();
  const saver = page.locator('[data-smear-screensaver]');
  await saver.waitFor({ timeout: 3000 });

  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('[data-smear-screensaver] span')].some((s) =>
        /^\d+s$/.test(s.textContent.trim()),
      ),
    undefined,
    { timeout: 4000 },
  );

  await ctx.close();
});

test('點說明開細節對話框 —— 不跳頁,而且輪播停住', async (t) => {
  const opened = await open(t);
  if (!opened) return;
  const { ctx, page } = opened;
  await page.mouse.move(5, 5);

  const urlBefore = page.url();
  const idBefore = await currentId(page);

  // 先確認入口找得到,再確認點下去真的長出東西 —— 少了前半段,選擇器腐爛時
  // 這條會變成空掃的綠燈。
  const opener = page
    .locator('[data-smear-gallery] button', { hasText: ITEMS[0].canonical_long })
    .first();
  await opener.waitFor({ timeout: 3000 });
  await opener.click();

  const dialog = page.locator('[data-smear-detail-dialog]');
  await dialog.waitFor({ timeout: 3000 });
  assert.equal(page.url(), urlBefore, '這個對話框的重點就是不跳頁');

  // 對話框開著時輪播要停:讀到一半底下換過好幾張,關掉才發現,是最難回報的
  // 那種壞法。
  await page.waitForTimeout(WAIT_MS);
  assert.equal(
    await currentId(page),
    idBefore,
    '對話框開著的時候輪播還在跑',
  );

  await page.getByRole('button', { name: '關閉' }).click();
  await dialog.waitFor({ state: 'detached', timeout: 3000 });

  await ctx.close();
});

test('寬螢幕的全螢幕輪播是左右,不是上下', async (t) => {
  // 窄螢幕與橫向手機才把說明放到圖下面(視窗矮,側欄會把圖擠成一條)。
  // ⚠️ 兩側都要取樣:只驗寬螢幕的話,「一律左右」也會綠。
  const opened = await open(t, { paused: true });
  if (!opened) return;
  const { ctx, page } = opened;

  const geometry = async () =>
    page.evaluate(() => {
      const saver = document.querySelector('[data-smear-screensaver]');
      const img = saver.querySelector('img').getBoundingClientRect();
      // 說明欄 = 帶捲軸、含標題的那一塊
      const panel = saver
        .querySelector('.tiptap, h3')
        .closest('div[class*="overflow-y-auto"]')
        .getBoundingClientRect();
      return {
        imgRight: img.right, panelLeft: panel.left,
        imgBottom: img.bottom, panelTop: panel.top,
        panelHeight: panel.height, viewportHeight: window.innerHeight,
      };
    });

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole('button', { name: '全螢幕輪播' }).first().click();
  await page.locator('[data-smear-screensaver]').waitFor({ timeout: 3000 });
  await page.waitForTimeout(500);
  const wide = await geometry();
  assert.ok(
    wide.panelLeft >= wide.imgRight - 1,
    `寬螢幕應該是左右並排:圖右緣 ${wide.imgRight}, 說明左緣 ${wide.panelLeft}`,
  );
  // ⚠️ 側欄要吃滿高度。實際踩到:`landscape:max-h-[42%]` 在 1280×900 上同時
  // 成立而且贏過 `lg:max-h-none`,右欄只有四成高、底下一整片黑 —— 而「左右並排」
  // 那條斷言照樣是綠的,所以高度得自己驗。
  assert.ok(
    wide.panelHeight > wide.viewportHeight * 0.9,
    `寬螢幕的說明側欄應該吃滿高度,實際只有 ${Math.round(wide.panelHeight)} / ${wide.viewportHeight}`,
  );

  // 對照組:窄螢幕才是上下
  await page.setViewportSize({ width: 700, height: 900 });
  await page.waitForTimeout(500);
  const narrow = await geometry();
  assert.ok(
    narrow.panelTop >= narrow.imgBottom - 1,
    `窄螢幕應該是上下:圖下緣 ${narrow.imgBottom}, 說明上緣 ${narrow.panelTop}`,
  );

  await ctx.close();
});

test('全螢幕的第一幀就有圖 —— 不是等 full 載完才出現', async (t) => {
  // ⚠️ 這條守的是實際回報的「開全螢幕卡卡的」。478 張裡有 203 張的 full 跟 view
  // 是不同的檔,而全螢幕的 <img> 是全新的元素 —— 修正前量到第一幀就是
  // `complete: false, naturalWidth: 0`,也就是圖片區整塊空白,等新檔載完才出現。
  const opened = await open(t, { paused: true });
  if (!opened) return;
  const { ctx, page } = opened;

  // 先確認卡片那張真的載好了(對照組):它沒載好的話,下面那條「第一幀有圖」
  // 本來就不可能成立,測試會紅在一個跟全螢幕無關的地方。
  await page.waitForFunction(
    () => {
      const i = document.querySelector('[data-smear-gallery] img');
      return !!i && i.complete && i.naturalWidth > 0;
    },
    undefined,
    { timeout: 5000 },
  );

  const first = await page.evaluate(async () => {
    const btn = [...document.querySelectorAll('[data-smear-gallery] button')].find(
      (b) => b.getAttribute('aria-label') === '全螢幕輪播',
    );
    btn.click();
    await new Promise((r) => queueMicrotask(() => queueMicrotask(r)));
    const img = document.querySelector('[data-smear-screensaver] img');
    return img && { complete: img.complete, natural: img.naturalWidth, src: img.getAttribute('src') };
  });

  assert.ok(first, '全螢幕裡找不到圖');
  assert.ok(
    first.complete && first.natural > 0,
    `全螢幕第一幀的圖是空的(complete=${first.complete}, naturalWidth=${first.natural}) —— 應該先畫卡片已經載好的 view`,
  );

  await ctx.close();
});

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

// 自動輪播是 10 秒(lib/smearGallery.ts 的 AUTO_ADVANCE_MS)。等 14 秒留四秒
// 餘裕 —— 寫死「剛好 10 秒」在忙碌的 CI 上會假紅。
const WAIT_MS = 14_000;

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

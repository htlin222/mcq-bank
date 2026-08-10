// 個人筆記的拖曳排序(#140)。
//
// 落點計算是純函式(`src/lib/reorder.test.ts`),請求的收斂也是
// (`worker/lib/notes-order.test.ts`)。這裡驗的是**中間那一段接線**:
// 握把出不出現、拖曳中畫面有沒有即時跟著走、放開時送出去的順序對不對。
//
// ⚠️ 放開之後畫面會**回到 fixture 的原順序** —— `reorderNotes` 結尾會 reload,
// 而 fixture 是靜態的。所以「拖完之後清單長怎樣」在這個環境裡驗不到,也不該驗;
// 真正的契約是那個 PUT 的內容。
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

function guard(t) {
  if (!skipReason) return false;
  if (REQUIRE) throw new Error(skipReason);
  t.skip(skipReason);
  return true;
}

const TITLES = `[...document.querySelectorAll('[role="menu"] li')].map((li) => li.textContent.trim().slice(0, 8))`;

/** 開到筆記面板 → 打開切換器下拉。 */
async function openPicker(page, width) {
  if (width < 768) {
    const tab = page.locator('button', { hasText: '詳解' }).first();
    if (await tab.count()) await tab.click().catch(() => {});
    await page.waitForTimeout(250);
  }
  await page.locator('button', { hasText: '個人筆記' }).first().click();
  await page.waitForTimeout(400);
  await page.click('[title="切換這一題的筆記"]');
  await page.waitForTimeout(300);
}

test('拖曳握把:畫面即時跟著走,放開時送出新順序', async (t) => {
  if (guard(t)) return;

  const ctx = await browser.newContext({
    viewport: { width: 390, height: 780 },
    isMobile: true,
    hasTouch: true,
  });
  let sent = null;
  await ctx.route('**/api/questions/*/notes/order', (route) => {
    sent = { method: route.request().method(), body: route.request().postDataJSON() };
    return route.fulfill({
      status: 200,
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify({ ok: true }),
    });
  });

  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  try {
    await page.goto(server.origin + '/q/113-050', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(800);
    await openPicker(page, 390);

    const before_ = await page.evaluate(TITLES);
    assert.equal(before_.length, 2, `fixture 要有兩則筆記才拖得動,實際 ${before_.length}`);

    const handles = page.locator('[aria-label^="拖曳排序"]');
    assert.equal(await handles.count(), 2, '每一列都該有一個握把');

    const h = await handles.nth(0).boundingBox();
    const rows = await page.locator('[role="menu"] li').all();
    const second = await rows[1].boundingBox();

    // 按住第一列的握把,拖過第二列的中線。
    await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
    await page.mouse.down();
    await page.mouse.move(h.x + h.width / 2, second.y + second.height / 2 + 8, { steps: 8 });
    await page.waitForTimeout(120);

    // 還沒放開 —— 畫面應該已經換位置了。少了這條,「拖曳有沒有反應」完全沒被驗到
    // (放開之後 reload 會把順序拉回 fixture,看不出差別)。
    const during = await page.evaluate(TITLES);
    assert.notDeepEqual(during, before_, '拖曳中畫面沒有跟著走');
    assert.deepEqual(during, [before_[1], before_[0]], `拖曳中的順序不對:${during}`);

    await page.mouse.up();
    await page.waitForTimeout(600);

    assert.ok(sent, '放開之後沒有送出排序請求');
    assert.equal(sent.method, 'PUT');
    assert.deepEqual(sent.body.slots, [1, 0], `送出的順序不對:${JSON.stringify(sent.body)}`);
    assert.deepEqual(errors, []);
  } finally {
    await ctx.close();
  }
});

test('原地放開不送請求 —— 那只是一次沒改變任何東西的往返', async (t) => {
  if (guard(t)) return;

  const ctx = await browser.newContext({
    viewport: { width: 390, height: 780 },
    isMobile: true,
    hasTouch: true,
  });
  let sent = 0;
  await ctx.route('**/api/questions/*/notes/order', (route) => {
    sent++;
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });

  const page = await ctx.newPage();
  try {
    await page.goto(server.origin + '/q/113-050', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(800);
    await openPicker(page, 390);

    const h = await page.locator('[aria-label^="拖曳排序"]').nth(0).boundingBox();
    assert.ok(h, '找不到握把 —— 這條測試沒在驗東西');

    await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
    await page.mouse.down();
    await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2 + 3, { steps: 3 });
    await page.mouse.up();
    await page.waitForTimeout(500);

    assert.equal(sent, 0, '順序沒變卻送出了請求');
  } finally {
    await ctx.close();
  }
});

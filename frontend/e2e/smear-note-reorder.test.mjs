// 抹片個人筆記的拖曳排序(#249)。
//
// 落點與「放回原位不送」是純函式。這裡驗接線:握把在、拖曳中清單跟著走、
// 放開送出的是筆記 id 的完整排列(不是 sort_order 數字,也不是改掉 id)。
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

function note(id, text) {
  return {
    id,
    dx_id: 'dacrocyte',
    content_json: JSON.stringify({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
    }),
    sort_order: id === 'note-a' ? 0 : 1,
    created_at: 1700000000000,
    updated_at: 1700000000000,
  };
}

const NOTES = [note('note-a', '淚滴狀紅血球'), note('note-b', '第二則筆記')];

const TITLES =
  `[...document.querySelectorAll('[role="listbox"] li')].map((li) => li.textContent.trim().replace(/^\\d+\\.\\s*/, ''))`;

async function openPicker(page) {
  await page.goto(server.origin + '/smear/dx/dacrocyte', { waitUntil: 'domcontentloaded' });
  await page.getByRole('tab', { name: '個人筆記' }).click();
  await page.getByRole('button', { name: /淚滴狀紅血球/ }).click();
  await page.locator('[role="listbox"]').waitFor();
}

function installNotes(ctx, onOrder) {
  return ctx.route('**/api/smear/dx/dacrocyte/notes**', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/notes/order')) return onOrder(route);
    if (route.request().method() === 'GET' && url.pathname.endsWith('/notes')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify({ items: NOTES }),
      });
    }
    return route.fallback();
  });
}

test('拖曳握把:畫面即時跟著走,放開時送出筆記 id 的新順序', async (t) => {
  if (guard(t)) return;
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 780 },
    isMobile: true,
    hasTouch: true,
  });
  let sent = null;
  await installNotes(ctx, (route) => {
    sent = { method: route.request().method(), body: route.request().postDataJSON() };
    return route.fulfill({
      status: 200,
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify({ ok: true, ids: ['note-b', 'note-a'] }),
    });
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    await openPicker(page);
    const before_ = await page.evaluate(TITLES);
    assert.deepEqual(before_, ['淚滴狀紅血球', '第二則筆記']);

    const handles = page.locator('[aria-label^="拖曳排序"]');
    assert.equal(await handles.count(), 2, '每一列都該有一個握把');
    const h = await handles.nth(0).boundingBox();
    const rows = await page.locator('[role="listbox"] li').all();
    const second = await rows[1].boundingBox();
    assert.ok(h && second, '握把或列量不到');

    await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
    await page.mouse.down();
    await page.mouse.move(h.x + h.width / 2, second.y + second.height / 2 + 8, { steps: 8 });
    await page.waitForTimeout(120);

    const during = await page.evaluate(TITLES);
    assert.deepEqual(during, ['第二則筆記', '淚滴狀紅血球'], `拖曳中的順序不對:${during}`);

    await page.mouse.up();
    await page.waitForTimeout(400);
    assert.ok(sent, '放開之後沒有送出排序請求');
    assert.equal(sent.method, 'PUT');
    assert.deepEqual(sent.body.ids, ['note-b', 'note-a']);
    assert.deepEqual(errors, []);
  } finally {
    await ctx.close();
  }
});

test('原地放開不送請求', async (t) => {
  if (guard(t)) return;
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 780 },
    isMobile: true,
    hasTouch: true,
  });
  let sent = 0;
  await installNotes(ctx, (route) => {
    sent++;
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });
  const page = await ctx.newPage();
  try {
    await openPicker(page);
    const h = await page.locator('[aria-label^="拖曳排序"]').nth(0).boundingBox();
    assert.ok(h, '找不到握把 —— 這條測試沒在驗東西');
    await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
    await page.mouse.down();
    await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2 + 3, { steps: 3 });
    await page.mouse.up();
    await page.waitForTimeout(400);
    assert.equal(sent, 0, '順序沒變卻送出了請求');
  } finally {
    await ctx.close();
  }
});

// 筆試首頁列出已交卷、還沒登記進複習的場次(#257)。按鈕打的是成績頁
// 同一支 apply-to-review,不帶 question_ids。清單空的時候不送請求。

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
    skipReason = '沒有 playwright';
    return;
  }
  try {
    browser = await webkit.launch();
  } catch (e) {
    skipReason = `WebKit 起不來:${e.message.split('\n')[0]}`;
    return;
  }
  server = await startServer({ dist: DIST });
});

after(async () => {
  if (server) await server.close();
  if (browser) await browser.close();
});

async function openExamHome(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(server.origin + '/?tab=exam', { waitUntil: 'domcontentloaded' });
  return errors;
}

test('交卷後沒登記,筆試首頁看得到場次與題數,按鈕打既有端點', async (t) => {
  if (skipReason) {
    if (REQUIRE) assert.fail(`E2E_REQUIRE=1 但無法執行:${skipReason}`);
    return t.skip(skipReason);
  }
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const posts = [];
  page.on('request', (req) => {
    if (req.method() === 'POST' && req.url().includes('/apply-to-review')) {
      posts.push({ url: req.url(), body: req.postData() });
    }
  });
  await ctx.route('**/*', (r) =>
    r.request().url().startsWith(server.origin) ? r.continue() : r.abort(),
  );
  try {
    const errors = await openExamHome(page);
    const card = page.locator('#pending-review');
    await card.getByText('12 題會登記').waitFor({ timeout: 15_000 });
    assert.match(await card.innerText(), /民國 113 年/);
    const btn = card.locator('button', { hasText: '登記進複習進度' });
    assert.equal(await btn.count(), 1);
    await btn.click();
    await card.getByText('沒有需要登記的題目').waitFor({ timeout: 15_000 });
    assert.equal(posts.length, 1);
    assert.match(posts[0].url, /\/api\/exam\/s-pending\/apply-to-review$/);
    const body = posts[0].body ? JSON.parse(posts[0].body) : {};
    assert.equal(body.question_ids, undefined);
    assert.equal(await card.locator('button', { hasText: '登記進複習進度' }).count(), 0);
    assert.deepEqual(errors, []);
  } finally {
    await ctx.close();
  }
});

test('沒有考對的題時不送出空登記', async (t) => {
  if (skipReason) {
    if (REQUIRE) assert.fail(`E2E_REQUIRE=1 但無法執行:${skipReason}`);
    return t.skip(skipReason);
  }
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const posts = [];
  page.on('request', (req) => {
    if (req.method() === 'POST' && req.url().includes('/apply-to-review')) posts.push(req.url());
  });
  await ctx.route('**/*', (r) =>
    r.request().url().startsWith(server.origin) ? r.continue() : r.abort(),
  );
  // 後註冊的比較先匹配。空清單要蓋過 fixture。
  await ctx.route('**/api/exam/pending-review', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ sessions: [] }),
    }),
  );
  try {
    const errors = await openExamHome(page);
    const card = page.locator('#pending-review');
    await card.getByText('沒有需要登記的題目').waitFor({ timeout: 15_000 });
    assert.equal(await card.locator('button').count(), 0);
    assert.deepEqual(posts, []);
    assert.deepEqual(errors, []);
  } finally {
    await ctx.close();
  }
});

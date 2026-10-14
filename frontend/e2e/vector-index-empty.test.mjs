// 語意索引沒回填時,相似題與弱點地圖要自己講出來,而且退回的結果還在。
// fixture 本身沒有 index_empty,所以「有索引」那條直接走現成回應。

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(HERE, '..', 'dist');
const REQUIRE = process.env.E2E_REQUIRE === '1';
const NOTICE = '語意索引尚未回填';

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

function skip(t) {
  if (!skipReason) return false;
  if (REQUIRE) assert.fail(skipReason);
  t.skip(skipReason);
  return true;
}

test('弱點地圖:空索引仍列出主題,並寫明尚未回填', async (t) => {
  if (skip(t)) return;
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const base = JSON.parse(
    fs.readFileSync(path.join(HERE, 'fixtures', 'review_weakness-map.json'), 'utf8'),
  );
  await page.route('**/api/review/weakness-map', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ...base, index_empty: true, basis: 'topic' }),
    }),
  );
  try {
    await page.goto(server.origin + '/weakness-map', { waitUntil: 'domcontentloaded' });
    await page.getByText(NOTICE).waitFor({ timeout: 10_000 });
    await page.getByRole('heading', { name: '骨髓增生性腫瘤' }).waitFor({ timeout: 5_000 });
    assert.equal(errors.length, 0, errors.join('\n'));
  } finally {
    await ctx.close();
  }
});

test('弱點地圖:索引有資料時不出現那句話', async (t) => {
  if (skip(t)) return;
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    await page.goto(server.origin + '/weakness-map', { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: '骨髓增生性腫瘤' }).waitFor({ timeout: 10_000 });
    assert.equal(await page.getByText(NOTICE).count(), 0);
    assert.equal(errors.length, 0, errors.join('\n'));
  } finally {
    await ctx.close();
  }
});

test('相似題:空索引仍列出退回的題,並寫明尚未回填', async (t) => {
  if (skip(t)) return;
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/api/questions/113-050/similar', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        index_empty: true,
        items: [
          {
            id: '112-010',
            year: 112,
            number: 10,
            stem: '索引空時仍看得到的 BM25 題幹',
            group: '內科',
            shared_tags: 0,
            source: 'fts',
          },
        ],
      }),
    }),
  );
  try {
    await page.goto(server.origin + '/q/113-050', { waitUntil: 'domcontentloaded' });
    const tab = page.getByRole('button', { name: '相似題目' }).first();
    await tab.waitFor({ timeout: 10_000 });
    await tab.click();
    await page.getByText(NOTICE).waitFor({ timeout: 10_000 });
    await page.getByText('索引空時仍看得到的 BM25 題幹').waitFor({ timeout: 5_000 });
    assert.equal(errors.length, 0, errors.join('\n'));
  } finally {
    await ctx.close();
  }
});

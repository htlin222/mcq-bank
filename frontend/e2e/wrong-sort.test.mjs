// 錯題回顧的排序下拉。
//
// 排序做在伺服器端,而清單一次最多 200 列 —— 所以排序決定的不只是順序,是**哪
// 200 列**。前端只負責把選到的值放進 query string,這支驗的就是那一段接線:
//
//   1. 下拉真的在畫面上,而且預設是舊行為(按錯誤率)。
//   2. 選了之後請求真的帶上 `sort=`。**這是重點** —— 只驗畫面的話,一個「選了
//      但沒重抓」的實作也會全綠,而它的症狀是「排序有時候有效有時候沒效」。
//   3. 預設**不**帶 `sort` 參數(刻意的:少一個會過期的網址參數)。
//
// 伺服器那側認不得的值會靜靜退回預設排序,所以鍵的一致性由
// `src/lib/wrongSort.test.ts` 另外釘死 —— 那條在這裡驗不到。
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

test('選了排序就重抓,而且帶上 sort 參數', async (t) => {
  if (skipReason) {
    if (REQUIRE) assert.fail(`E2E_REQUIRE=1 但無法執行:${skipReason}`);
    return t.skip(skipReason);
  }

  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    serviceWorkers: 'block',
  });
  const hits = [];
  // ⚠️ 順序:Playwright 後註冊的先比對,所以擋外連的 catch-all 要先掛。
  await ctx.route('**/*', (r) =>
    r.request().url().startsWith(server.origin) ? r.continue() : r.abort(),
  );
  await ctx.route('**/api/review/wrong*', (r) => {
    hits.push(new URL(r.request().url()).search);
    return r.continue();
  });

  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  try {
    await page.goto(`${server.origin}/wrong`, { waitUntil: 'domcontentloaded' });

    const select = page.locator('select[aria-label="排序方式"]');
    await select.waitFor({ timeout: 20_000 });

    // 空掃防線:清單真的有東西,否則「重抓了」也可能只是頁面壞掉重試。
    await page.locator('a[href="/q/113-002"]').first().waitFor({ timeout: 20_000 });

    assert.equal(await select.inputValue(), 'rate', '預設不是舊行為(按錯誤率)');
    assert.ok(
      (await page.evaluate(() => document.body.innerText)).includes('按錯誤率排序'),
      '說明文字沒有寫出目前的排序',
    );
    assert.deepEqual(hits, [''], `預設不該帶 sort 參數,實際送出:${JSON.stringify(hits)}`);

    await select.selectOption('recent');
    await page.waitForTimeout(400);

    assert.equal(hits.length, 2, `選了排序卻沒有重抓(送出 ${hits.length} 次)`);
    assert.equal(hits[1], '?sort=recent');
    assert.ok(
      (await page.evaluate(() => document.body.innerText)).includes('最近做過的排前面'),
      '說明文字沒有跟著排序換',
    );

    // 選回預設:參數要整個消失,不是 sort=rate。
    await select.selectOption('rate');
    await page.waitForTimeout(400);
    assert.equal(hits.at(-1), '', `選回預設之後仍然帶著參數:${hits.at(-1)}`);

    assert.deepEqual(errors, []);
  } finally {
    await ctx.close();
  }
});

test('排序跟既有的年度 / group filter 疊加,不是互相取代', async (t) => {
  if (skipReason) {
    if (REQUIRE) assert.fail(`E2E_REQUIRE=1 但無法執行:${skipReason}`);
    return t.skip(skipReason);
  }

  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    serviceWorkers: 'block',
  });
  const hits = [];
  await ctx.route('**/*', (r) =>
    r.request().url().startsWith(server.origin) ? r.continue() : r.abort(),
  );
  await ctx.route('**/api/review/wrong*', (r) => {
    hits.push(new URL(r.request().url()).search);
    return r.continue();
  });
  const page = await ctx.newPage();

  try {
    await page.goto(`${server.origin}/wrong`, { waitUntil: 'domcontentloaded' });
    await page.locator('select[aria-label="排序方式"]').waitFor({ timeout: 20_000 });

    await page.locator('select[aria-label="排序方式"]').selectOption('misses');
    await page.waitForTimeout(300);
    // 年度那顆沒有 aria-label,用選項文字定位它自己。
    const yearSelect = page.locator('select').first();
    await yearSelect.selectOption('113');
    await page.waitForTimeout(400);

    const last = hits.at(-1);
    assert.ok(last.includes('year=113'), `年度沒有進 query:${last}`);
    assert.ok(last.includes('sort=misses'), `換年度把排序弄丟了:${last}`);
  } finally {
    await ctx.close();
  }
});

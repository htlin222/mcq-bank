// 「換題不再等網路」的行為證據。
//
// 這是唯一能真正驗到 questionCache 有沒有在做事的層級:單元測試證明 store 的
// 語意對,但證明不了 Question.tsx 真的在閒置時把鄰居抓進來、也證明不了
// useQuestion 真的在 render 當下就同步讀得到它。
//
// 做法是把伺服器的每個 /api/ 回應延遲 700ms,於是「有沒有預抓到」變成一段肉眼
// 可辨的時間差:預抓命中就不必付這 700ms,沒命中就得付滿。斷言用的門檻(300ms)
// 遠低於延遲本身,所以它量的是機制,不是機器快慢。
//
// 同時守住另一半:換題**當下**畫面上不可以還留著上一題的內容。那是這次修改前
// 的真實行為 —— data 不隨 id 清空,使用者按下下一題後會盯著上一題看好幾百毫秒,
// 連答案都還揭曉著。

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(HERE, '..', 'dist');
const REQUIRE = process.env.E2E_REQUIRE === '1';

const API_DELAY_MS = 700;
// 113-050 是 fixture 年度清單的最後一題,所以它的鄰居是「上一題」113-049。
const FROM = '/q/113-050';
const NEIGHBOUR_TEXT = 'immunophenotyping'; // 113-049 題幹開頭
const CURRENT_TEXT = '孟買血型'; // 113-050 選項

let browser = null;
let server = null;
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
  server = await startServer({ dist: DIST, apiDelayMs: API_DELAY_MS });
});

after(async () => {
  if (server) await server.close();
  if (browser) await browser.close();
});

async function openQuestionPage() {
  const { devices } = await import('playwright');
  const ctx = await browser.newContext({
    ...devices['Desktop Safari'],
    // Service Worker 會插進 fetch 之間、也會自己去打 /api,量測會失準。
    serviceWorkers: 'block',
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.stack || e.message));
  await ctx.route('**/*', (r) =>
    r.request().url().startsWith(server.origin) ? r.continue() : r.abort(),
  );
  await page.goto(server.origin + FROM, {
    waitUntil: 'domcontentloaded',
    timeout: 30_000,
  });
  await page.getByText(CURRENT_TEXT).first().waitFor({ timeout: 20_000 });
  return { ctx, page, errors };
}

test('預抓命中後,按「上一題」幾乎立刻換好內容(遠快於 API 延遲)', async (t) => {
  if (skipReason) {
    if (REQUIRE) assert.fail(`E2E_REQUIRE=1 但無法執行:${skipReason}`);
    return t.skip(skipReason);
  }

  const { ctx, page, errors } = await openQuestionPage();
  try {
    // 給閒置預抓跑完的時間:一次 API 延遲再加一點餘裕。
    await page.waitForTimeout(API_DELAY_MS * 3);

    const btn = page.getByRole('button', { name: /上一題/ });
    await btn.waitFor({ timeout: 10_000 });

    const t0 = Date.now();
    await btn.click();
    await page.getByText(NEIGHBOUR_TEXT).first().waitFor({ timeout: 20_000 });
    const elapsed = Date.now() - t0;

    assert.ok(
      elapsed < 300,
      `換題花了 ${elapsed}ms —— 超過門檻就表示預抓沒命中,又去等了那趟 ${API_DELAY_MS}ms 的請求`,
    );
    assert.equal(errors.length, 0, `換題時有未捕捉例外:\n${errors.join('\n---\n')}`);
  } finally {
    await ctx.close();
  }
});

test('換題後畫面上不會殘留上一題的內容', async (t) => {
  if (skipReason) {
    if (REQUIRE) assert.fail(`E2E_REQUIRE=1 但無法執行:${skipReason}`);
    return t.skip(skipReason);
  }

  const { ctx, page, errors } = await openQuestionPage();
  try {
    await page.waitForTimeout(API_DELAY_MS * 3);
    await page.getByRole('button', { name: /上一題/ }).click();
    await page.getByText(NEIGHBOUR_TEXT).first().waitFor({ timeout: 20_000 });

    const text = await page.evaluate(() => document.body.innerText);
    assert.ok(
      !text.includes(CURRENT_TEXT),
      `新題目已經出現,但上一題的內容還在畫面上:\n${text.slice(0, 300)}`,
    );
    assert.equal(errors.length, 0, `換題時有未捕捉例外:\n${errors.join('\n---\n')}`);
  } finally {
    await ctx.close();
  }
});

test('同一年度換題不會重抓年度清單(prev/next 按鈕跟題目同一幀出現)', async (t) => {
  if (skipReason) {
    if (REQUIRE) assert.fail(`E2E_REQUIRE=1 但無法執行:${skipReason}`);
    return t.skip(skipReason);
  }

  const { ctx, page, errors } = await openQuestionPage();
  try {
    await page.waitForTimeout(API_DELAY_MS * 3);
    const before = server.apiHits().filter((u) => u.startsWith('/api/questions?year=')).length;

    await page.getByRole('button', { name: /上一題/ }).click();
    await page.getByText(NEIGHBOUR_TEXT).first().waitFor({ timeout: 20_000 });
    await page.waitForTimeout(API_DELAY_MS * 2);

    const after = server.apiHits().filter((u) => u.startsWith('/api/questions?year=')).length;
    assert.equal(
      after,
      before,
      `換題又抓了 ${after - before} 次年度清單 —— yearListCache 沒有生效`,
    );
    assert.equal(errors.length, 0, `換題時有未捕捉例外:\n${errors.join('\n---\n')}`);
  } finally {
    await ctx.close();
  }
});

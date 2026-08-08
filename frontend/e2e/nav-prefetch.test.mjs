// 「換題不再等網路」的行為證據。
//
// 這是唯一能真正驗到 questionCache 有沒有在做事的層級:單元測試證明 store 的
// 語意對,但證明不了 Question.tsx 真的在閒置時把鄰居抓進來、也證明不了
// useQuestion 真的在 render 當下就同步讀得到它。
//
// 做法是把伺服器的每個 /api/ 回應延遲 700ms,再**把那條網路切斷**:預抓命中的話
// 畫面照樣出得來,沒命中就永遠出不來。
//
// 早期版本是量時間差(門檻 300ms vs 延遲 700ms),在本機一直是 37–119ms、看起來
// 很安全。但 CI runner 慢得多,光是頁面本身的工作就吃掉 600ms —— 於是兩條斷言在
// GitHub Actions 上一起紅,而機制其實完全正常。**2.3 倍的餘裕不是餘裕**:量牆上
// 時鐘就是在量那台機器,不是在量這段程式。
//
// 改成斷言「網路死掉也做得到」之後,結果只有兩種:預抓/樂觀更新有效,或者畫面
// 根本不會出現 —— 跟機器快慢完全無關,而且比「夠快」是更強的證據。
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

const API_DELAY_MS = 1500;
// 113-050 是 fixture 年度清單的最後一題,所以它的鄰居是「上一題」113-049。
const FROM = '/q/113-050';
const NEIGHBOUR_ID = '113-049';
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

test('預抓命中後,按「上一題」不再重抓題目 payload', async (t) => {
  if (skipReason) {
    if (REQUIRE) assert.fail(`E2E_REQUIRE=1 但無法執行:${skipReason}`);
    return t.skip(skipReason);
  }

  const { ctx, page, errors } = await openQuestionPage();
  try {
    // 給閒置預抓跑完的時間:一次 API 延遲再加一點餘裕。
    await page.waitForTimeout(API_DELAY_MS * 3);

    // 直接問伺服器:點下去到畫面換好之間,有沒有再抓一次這一題的 payload。
    // 預抓命中的話那趟請求早在閒置窗裡就發完了,這段區間應該是零。
    // 只算 payload 本身,不算 /comments /similar /videos —— 那些本來就是換題後才抓,
    // 算進去等於在驗別的東西。
    const payloadHits = () =>
      server.apiHits().filter((p) => p === `/api/questions/${NEIGHBOUR_ID}`).length;
    const before = payloadHits();

    const btn = page.getByRole('button', { name: /上一題/ });
    await btn.waitFor({ timeout: 10_000 });
    await btn.click();
    await page.getByText(NEIGHBOUR_TEXT).first().waitFor({ timeout: 20_000 });

    assert.equal(
      payloadHits(),
      before,
      '換題時又去抓了一次題目 payload —— 預抓沒命中,或 useQuestion 沒在 render 當下讀快取',
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

test('提交答案立刻揭曉,不等 /api/review/answer 回來', async (t) => {
  if (skipReason) {
    if (REQUIRE) assert.fail(`E2E_REQUIRE=1 但無法執行:${skipReason}`);
    return t.skip(skipReason);
  }

  const { ctx, page, errors } = await openQuestionPage();
  try {
    // 選 B(正解),再送出。伺服器每個 /api/ 都延遲 700ms,所以「有沒有等網路」
    // 是可觀測的:等了就至少 700ms,沒等就是幾十毫秒。
    // 選項是 <li> 不是 button,所以用文字點。113-050 的正解是 (B) 亞孟買血型。
    await page.getByText('先生為亞孟買血型').first().click();
    await page.getByRole('button', { name: '提交答案' }).waitFor({ timeout: 10_000 });

    await page.getByRole('button', { name: '提交答案' }).click();
    await page.getByText('答對了').first().waitFor({ timeout: 20_000 });

    // Resource Timing 的條目是**請求完成時**才寫進去的。揭曉已經上畫面、而那趟 POST
    // 還沒有條目,就證明揭曉沒有在等它 —— 伺服器每個 /api/ 都壓了 1500ms,所以這個
    // 判斷有足夠的空檔,而且完全不看牆上時鐘(#89)。
    const settledPosts = await page.evaluate(() =>
      performance
        .getEntriesByType('resource')
        .filter((e) => e.name.includes('/api/review/answer')).length,
    );
    assert.equal(
      settledPosts,
      0,
      '看見「答對了」的當下,/api/review/answer 已經回來了 —— 揭曉又在等網路。' +
        '正解本來就在 client 手上,沒有理由等(#89)',
    );
    assert.deepEqual(errors, [], `送出時有未捕捉例外:\n${errors.join('\n---\n')}`);
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

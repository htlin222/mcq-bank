// 續考從「第一題未作答」開始,不是第一題。
//
// 回報:暫停全真作答之後回來,畫面停在第 1 題 —— 而前面幾十題早就答過了,使用者
// 得自己翻到還沒答的地方。判準與邊界在 `src/lib/examResume.ts` 的單元測試裡;
// 這支驗的是**接線**:載入時真的有把 activeIdx 移過去。
//
// `running_since` 是絕對時間戳,靜態 fixture 給什麼都會過期(給過去的時間會一進
// 頁面就自動交卷,給 null 則整份題目不渲染)—— 同 exam-timer-bar.test.mjs,
// 「現在」由測試在請求當下注入,fixture 只提供形狀。
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

const STATE = JSON.parse(
  fs.readFileSync(path.join(HERE, 'fixtures', 'exam_e2e-1_state.json'), 'utf8'),
);

/** 前 n 題有作答,其餘一律清空 —— fixture 原本零星幾題有 chosen,留著會讓落點不可預期。 */
function withAnswered(n) {
  return {
    ...STATE,
    running_since: Date.now(),
    elapsed_ms: 60_000,
    questions: STATE.questions.map((q, i) => ({ ...q, chosen: i < n ? 'A' : null })),
  };
}

// 計時列上的「第 4 題 / 100」。回傳 null 表示頁面根本沒渲染出考試 —— 讓斷言紅在
// 原因上,而不是紅在題號對不對。兩處的「題」都寫成可有可無:那一行的排法動過
// (#205),不該因為排版微調就假紅。
const PROBE = `
  (() => {
    const m = /第\\s*(\\d+)\\s*題?\\s*\\/\\s*(\\d+)\\s*題?/.exec(document.body.innerText || '');
    return m ? { idx: Number(m[1]), total: Number(m[2]) } : null;
  })()
`;

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

async function open(answered) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 800 } });
  await ctx.route('**/api/exam/e2e-1/state', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify(withAnswered(answered)),
    }),
  );
  const page = await ctx.newPage();
  await page.goto(server.origin + '/exam/e2e-1', {
    waitUntil: 'domcontentloaded',
    timeout: 30_000,
  });
  await page.waitForTimeout(1200);
  const r = await page.evaluate(PROBE);
  await ctx.close();
  return r;
}

test('答過 3 題,續考落在第 4 題', async (t) => {
  if (skipReason) {
    if (REQUIRE) assert.fail(`E2E_REQUIRE=1 但無法執行:${skipReason}`);
    return t.skip(skipReason);
  }
  const r = await open(3);
  assert.ok(r, '頁面沒有渲染出「第 N / M 題」—— fixture 沒讓考試頁跑起來');
  assert.equal(r.total, 100, '題數不對,量到的可能不是這一場');
  assert.equal(r.idx, 4);
});

test('一題都沒答就從第 1 題開始', async (t) => {
  if (skipReason) {
    if (REQUIRE) assert.fail(`E2E_REQUIRE=1 但無法執行:${skipReason}`);
    return t.skip(skipReason);
  }
  const r = await open(0);
  assert.ok(r, '頁面沒有渲染出「第 N / M 題」');
  assert.equal(r.idx, 1);
});

test('全部答完回到第 1 題(要做的是檢查與交卷)', async (t) => {
  if (skipReason) {
    if (REQUIRE) assert.fail(`E2E_REQUIRE=1 但無法執行:${skipReason}`);
    return t.skip(skipReason);
  }
  const r = await open(100);
  assert.ok(r, '頁面沒有渲染出「第 N / M 題」');
  assert.equal(r.idx, 1);
});

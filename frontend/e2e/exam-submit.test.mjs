// 交卷是**一趟**請求,不是一題一趟。
//
// 回報是「卡在交卷中送不出去」,實際上是慢:舊版 submit() 逐題 POST
// `/api/exam/:sid/answer`,100 題就是 100 趟循序往返,而 `/answer` 內部還有兩趟
// D1。正式機量到每趟 1.30 秒 —— 交卷要等兩分鐘以上,使用者會以為當掉、重整再按
// 一次(attempts 裡留下 144 筆 elapsed_ms 為 NULL 的列涵蓋 100 題,就是一輪半)。
//
// 這支守的是**請求數**,不是時間:時間在測試環境量不準(fixture 伺服器沒有 D1
// 的往返成本),而請求數是那個成本的來源,且是確定性的。舊版在這份 33 題已作答
// 的 fixture 上會發 33 次;現在必須是 0 次單題請求 + 1 次批次請求。
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

const SID = 'e2e-1';
const STATE = JSON.parse(
  fs.readFileSync(path.join(HERE, 'fixtures', `exam_${SID}_state.json`), 'utf8'),
);

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

test('交卷:0 次單題請求 + 1 次批次請求 + 1 次 finish', async (t) => {
  if (skipReason) {
    if (REQUIRE) assert.fail(`E2E_REQUIRE=1 但無法執行:${skipReason}`);
    return t.skip(skipReason);
  }

  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    serviceWorkers: 'block',
  });
  const calls = { single: 0, bulk: 0, finish: 0, bulkBody: null };

  // 一條 route 認全部 /api/exam/*,在 handler 裡分類 —— 用兩條 glob 去分
  // `/answer` 與 `/answers` 太容易寫成互相覆蓋,而那會讓計數靜靜失真。
  await ctx.route('**/api/exam/**', async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    const json = (body) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify(body),
      });

    if (p.endsWith('/state')) {
      // running_since 是絕對時間戳,靜態 fixture 給什麼都會過期(給過去的時間,
      // client 會算出已超過上限而自動交卷)。所以「現在」在請求當下才注入。
      return json({ ...STATE, running_since: Date.now() });
    }
    if (p.endsWith('/answers') && req.method() === 'PUT') {
      calls.bulk++;
      calls.bulkBody = JSON.parse(req.postData() || '{}');
      return json({ changed: 0, unchanged: 33, unknown: 0, invalid: 0 });
    }
    if (p.endsWith('/answer')) {
      calls.single++;
      return json({ ok: true });
    }
    if (p.endsWith('/finish')) {
      calls.finish++;
      return json({ score: 20, duration_sec: 720 });
    }
    return json({});
  });

  const page = await ctx.newPage();
  // 33/100 已作答 → submit() 會先 confirm 一次。不接的話整條流程根本不會開始,
  // 而計數全 0 看起來就像「修好了」。
  page.on('dialog', (d) => d.accept());

  try {
    await page.goto(`${server.origin}/exam/${SID}`, { waitUntil: 'domcontentloaded' });

    // 空掃防線:交卷鈕要真的找得到。
    const btn = page.locator('button', { hasText: '交卷' }).first();
    await btn.waitFor({ timeout: 20_000 });

    await btn.click();
    await page.waitForURL(`**/exam/${SID}/result`, { timeout: 20_000 });

    assert.equal(
      calls.single,
      0,
      `交卷又走回逐題送出了(${calls.single} 次單題請求)—— 100 題的考卷會因此等上兩分鐘`,
    );
    assert.equal(calls.bulk, 1, '批次補送應該剛好一趟');
    assert.equal(calls.finish, 1, 'finish 應該剛好一趟');

    // 批次那一趟要真的帶著答案,否則「一趟」只是因為什麼都沒送。
    const sent = calls.bulkBody?.answers;
    assert.ok(Array.isArray(sent), `批次請求沒有 answers 陣列:${JSON.stringify(calls.bulkBody)}`);
    assert.equal(sent.length, 33, `送出的答案數不對:${sent.length}`);
    assert.ok(
      sent.every((a) => typeof a.question_id === 'string' && typeof a.chosen === 'string'),
      '批次請求裡有形狀不對的項目',
    );
  } finally {
    await ctx.close();
  }
});

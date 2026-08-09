// 送不出去的作答必須補得回來。
//
// 2026-08-09 在 e-ink 平板上連續四題(113-097～100)完全沒有進 D1 —— `attempts`
// 與 `review_progress` 都是 0 筆,換一台裝置看也一樣。不是快取問題,是那四趟
// POST 沒到伺服器,而失敗只設了一個元件 state:使用者按下一題,元件連同提示
// 一起被換掉,於是整輪答完才發現全部沒記錄。
//
// 這支測的是「離開之後還補得回來」,所以**重點在 reload 之後那一段** ——
// 補送若掛在元件上，換題就沒了，而那正是原本的行為。
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
const ANSWER = '/api/review/answer';

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

const posts = () => server.apiHits().filter((p) => p === ANSWER).length;

test('POST 失敗的作答會留在佇列,重新開啟 app 時補送出去', async (t) => {
  if (skipReason) {
    if (REQUIRE) assert.fail(`E2E_REQUIRE=1 但無法執行:${skipReason}`);
    return t.skip(skipReason);
  }

  const { devices } = await import('playwright');
  const ctx = await browser.newContext({ ...devices['Desktop Safari'], serviceWorkers: 'block' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => {
    const msg = e.stack || e.message;
    // `route.abort()` 製造的網路失敗，WebKit 會另外丟一個 "Fetch API cannot load
    // … due to access control checks"。那是**測試手法**的副產物,不是產品例外
    // (產品那邊已經 catch 了,所以佇列才留得住)。只濾掉這個 URL 的,其餘照抓。
    if (msg.includes(ANSWER) && msg.includes('Fetch API cannot load')) return;
    errors.push(msg);
  });

  // 只放行本站;並且**讓作答的 POST 失敗**,模擬弱訊號下送不出去。
  let blockAnswer = true;
  await ctx.route('**/*', (r) => {
    const u = r.request().url();
    if (!u.startsWith(server.origin)) return r.abort();
    if (blockAnswer && u.includes(ANSWER)) return r.abort('internetdisconnected');
    return r.continue();
  });

  try {
    await page.goto(server.origin + '/q/113-050', { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.getByText('孟買血型').first().waitFor({ timeout: 20_000 });

    await page.getByText('先生為亞孟買血型').first().click();
    await page.getByRole('button', { name: '提交答案' }).click();
    // 揭曉不等網路,所以這裡一定看得到 —— 但那正是危險之處:畫面說答對了,
    // 伺服器上卻什麼都沒有。
    await page.getByText('答對了').first().waitFor({ timeout: 20_000 });
    await page.waitForTimeout(1_500);

    const queued = await page.evaluate(() => {
      const raw = localStorage.getItem('mcq:attempt-outbox:v1');
      return raw ? JSON.parse(raw) : [];
    });
    // 正面斷言:確認這次真的走到「送不出去」那條路徑。少了它,POST 其實成功
    // 的話下面整段都會在驗一個沒發生過的情境。
    assert.equal(queued.length, 1, `作答沒有進佇列(佇列 ${queued.length} 筆)`);
    assert.equal(queued[0].question_id, '113-050');
    assert.equal(queued[0].chosen, 'B');

    // ── 這裡開始才是重點:使用者離開了,而且整頁重載 ──
    const before = posts();
    blockAnswer = false;
    await page.goto(server.origin + '/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForTimeout(3_000);

    assert.ok(
      posts() > before,
      '重新開啟 app 之後沒有補送 —— 佇列裡的作答永遠出不去',
    );

    const left = await page.evaluate(() => {
      const raw = localStorage.getItem('mcq:attempt-outbox:v1');
      return raw ? JSON.parse(raw).length : 0;
    });
    assert.equal(left, 0, '補送成功後佇列該清空,否則會一直重送');
    assert.deepEqual(errors, [], `有未捕捉例外:\n${errors.join('\n---\n')}`);
  } finally {
    await ctx.close();
  }
});

test('送得出去的時候不留佇列 —— 常態路徑不該累積東西', async (t) => {
  if (skipReason) {
    if (REQUIRE) assert.fail(`E2E_REQUIRE=1 但無法執行:${skipReason}`);
    return t.skip(skipReason);
  }

  const { devices } = await import('playwright');
  const ctx = await browser.newContext({ ...devices['Desktop Safari'], serviceWorkers: 'block' });
  const page = await ctx.newPage();
  await ctx.route('**/*', (r) =>
    r.request().url().startsWith(server.origin) ? r.continue() : r.abort(),
  );

  try {
    await page.goto(server.origin + '/q/113-050', { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.getByText('孟買血型').first().waitFor({ timeout: 20_000 });
    await page.getByText('先生為亞孟買血型').first().click();
    await page.getByRole('button', { name: '提交答案' }).click();
    await page.getByText('答對了').first().waitFor({ timeout: 20_000 });
    await page.waitForTimeout(1_500);

    const left = await page.evaluate(() => {
      const raw = localStorage.getItem('mcq:attempt-outbox:v1');
      return raw ? JSON.parse(raw).length : 0;
    });
    assert.equal(left, 0, 'POST 成功後佇列沒被清掉,下次開 app 會重送一筆多餘的');
  } finally {
    await ctx.close();
  }
});

// 斷網那幾題 → 網路回來 → 繼續作答。積壓的必須跟著送出去,不能等下一次
// online / 切回前景 —— 在一台會自己關 WiFi 的裝置上,那兩個事件不一定會再來。
// 「這一趟 POST 成功」本身就是「網路現在通了」最強的證據。
test('網路恢復後的下一次作答,會把先前積壓的一起送出去', async (t) => {
  if (skipReason) {
    if (REQUIRE) assert.fail(`E2E_REQUIRE=1 但無法執行:${skipReason}`);
    return t.skip(skipReason);
  }

  const { devices } = await import('playwright');
  const ctx = await browser.newContext({ ...devices['Desktop Safari'], serviceWorkers: 'block' });
  const page = await ctx.newPage();
  await ctx.route('**/*', (r) =>
    r.request().url().startsWith(server.origin) ? r.continue() : r.abort(),
  );

  try {
    await page.goto(server.origin + '/q/113-050', { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.getByText('孟買血型').first().waitFor({ timeout: 20_000 });

    // 先手動塞兩筆積壓,模擬「斷網時答的那幾題」。直接寫 localStorage 而不是
    // 真的斷網再作答:這條要驗的是「積壓會不會被帶出去」,不是「怎麼進去的」。
    await page.evaluate(() => {
      localStorage.setItem('mcq:attempt-outbox:v1', JSON.stringify([
        { idem: 'stale-1', question_id: '113-097', chosen: 'A', confidence: 2, elapsed_ms: 900, queued_at: 1 },
        { idem: 'stale-2', question_id: '113-098', chosen: 'C', confidence: 4, elapsed_ms: 800, queued_at: 2 },
      ]));
    });

    const before = posts();
    await page.getByText('先生為亞孟買血型').first().click();
    await page.getByRole('button', { name: '提交答案' }).click();
    await page.getByText('答對了').first().waitFor({ timeout: 20_000 });
    await page.waitForTimeout(2_500);

    // 這一題 + 兩筆積壓 = 至少 3 趟
    assert.ok(
      posts() - before >= 3,
      `只送了 ${posts() - before} 趟 —— 積壓沒有跟著出去(應該是 1 題 + 2 筆積壓)`,
    );
    const left = await page.evaluate(() => {
      const raw = localStorage.getItem('mcq:attempt-outbox:v1');
      return raw ? JSON.parse(raw).length : 0;
    });
    assert.equal(left, 0, '積壓送出後佇列該清空');
  } finally {
    await ctx.close();
  }
});

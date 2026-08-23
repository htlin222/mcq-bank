// 成績頁的每張卡片可以展開看**選項全文**。
//
// 在這之前,檢討時要看「B 選項到底寫什麼」只能點進 /q/:id 離開成績頁 ——
// 而檢討 100 題就是進出 100 次。展開區原本只有選項分布的百分比長條,字母底下
// 沒有內容,對不上題目。
//
// 這支的形狀有兩個刻意的地方:
//
//   1. **先斷言展開前看不到選項文字**,再斷言展開後看得到。少了前半段,一個
//      「永遠都畫出來」的實作也會全綠 —— 而那正是最容易寫出來的錯。
//   2. 分布(/stats)刻意沒有 fixture,回的是 `{}`。選項仍然必須畫得出來:
//      人數不足 / 未作答 / 載入失敗時,展開的主要目的(看選項)不該一起消失。
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
// 第 1 題(答錯 B、正解 A)的選項文字 —— 從 fixture 推出來,不要另外手寫一份。
const FIXTURE = JSON.parse(
  fs.readFileSync(path.join(HERE, 'fixtures', `exam_${SID}.json`), 'utf8'),
);
const Q1 = FIXTURE.answers[0];

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

test('成績頁:卡片展開才看得到選項全文,正解與自己選的都標出來', async (t) => {
  if (skipReason) {
    if (REQUIRE) assert.fail(`E2E_REQUIRE=1 但無法執行:${skipReason}`);
    return t.skip(skipReason);
  }

  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    serviceWorkers: 'block',
  });
  await ctx.route('**/*', (r) =>
    r.request().url().startsWith(server.origin) ? r.continue() : r.abort(),
  );
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  try {
    await page.goto(`${server.origin}/exam/${SID}/result`, {
      waitUntil: 'domcontentloaded',
    });

    // 空掃防線:預設篩選是「答錯/未答」,fixture 裡有兩題落在那裡。
    const toggles = page.locator('button', { hasText: '展開選項' });
    await toggles.first().waitFor({ timeout: 20_000 });
    assert.equal(await toggles.count(), 2, '答錯/未答的卡片數不對');

    // ⚠️ 不能用 hasText('展開選項') 當把手:展開之後那顆按鈕會改寫成「收合選項」,
    // 於是同一個 locator 的 first() 變成**第二張卡**,再按一下是展開別人而不是
    // 收合自己。認 aria-controls,它跟著題號走、不隨狀態改變。
    const toggle = page.locator(`[aria-controls="opts-${Q1.question_id}"]`);

    const bodyText = () => page.evaluate(() => document.body.innerText);

    // 展開前:選項文字不該在畫面上。
    const before = await bodyText();
    assert.ok(
      !before.includes(Q1.options.B),
      '還沒展開就看得到選項文字 —— 那樣這個 accordion 沒有意義',
    );

    await toggle.click();
    await page.waitForTimeout(250);

    const after = await bodyText();
    for (const [L, text] of Object.entries(Q1.options)) {
      assert.ok(after.includes(text), `展開後看不到選項 ${L}:${text}`);
    }
    assert.ok(after.includes('✓ 正解'), '沒有標出正解');
    assert.ok(after.includes('你選的'), '沒有標出自己選的那一項');

    // 收合要收得回去 —— accordion 的另一半。
    await toggle.click();
    await page.waitForTimeout(250);
    assert.ok(
      !(await bodyText()).includes(Q1.options.B),
      '按了收合之後選項還在',
    );

    assert.deepEqual(errors, []);
  } finally {
    await ctx.close();
  }
});

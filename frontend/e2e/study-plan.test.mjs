// 讀書計畫對話 —— WebKit 上把七題答完,計畫摘要要出得來。
//
// 為什麼需要一支獨立的 e2e:smoke.test.mjs 只會「打開路徑」,而這個功能整個
// 活在一個 portal 掛載的 modal 裡,不點就不存在 —— 首頁渲染成功完全不構成
// 它可用的證據。而它正好是最容易在 WebKit 上壞掉的形狀:portal + 七次連續
// state 更新 + 每次更新後 scrollIntoView。
//
// 一樣打正式建置產物、一樣接 fixture 伺服器(不需要 D1 或 Cloudflare 憑證)。
// 沒裝 playwright / webkit 時跳過;CI 設 E2E_REQUIRE=1 讓它改為失敗。

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

/** 七題的答案。順序即 STEPS 的順序 —— 錯一步後面就點不到,測試會在該步失敗。 */
const ANSWERS = [
  '對,以系統紀錄為準',
  '就這些',
  '30 分鐘',
  '就用 85 秒',
  '3 輪',
  '4 場',
  '產生計畫',
];

test('WebKit / iPhone:七題答完後產出計畫摘要', async (t) => {
  if (skipReason) {
    if (REQUIRE) assert.fail(`E2E_REQUIRE=1 但無法執行:${skipReason}`);
    return t.skip(skipReason);
  }

  const { devices } = await import('playwright');
  const ctx = await browser.newContext(devices['iPhone 13']);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.stack || e.message));

  // 掐掉跨源請求 —— index.html 會拉 Google Fonts,沒外網的機器上會等到逾時,
  // 而逾時的樣子跟真的壞掉沒兩樣。
  await ctx.route('**/*', (r) =>
    r.request().url().startsWith(server.origin) ? r.continue() : r.abort(),
  );

  try {
    await page.goto(`${server.origin}/`, {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });

    const open = page.getByRole('button', { name: '生成讀書計畫' });
    await open.waitFor({ timeout: 15_000 });
    await open.click();

    const dialog = page.getByRole('dialog', { name: '生成讀書計畫' });
    await dialog.waitFor({ timeout: 10_000 });

    for (const label of ANSWERS) {
      const btn = dialog.getByRole('button', { name: label, exact: true });
      await btn.waitFor({ timeout: 10_000 });
      await btn.click();
    }

    // 摘要 + 排不完的差額 + 三條建議(fixture 刻意選了排不完的一組參數)。
    await dialog.getByText('已排入題數').waitFor({ timeout: 10_000 });
    const text = await dialog.evaluate((el) => el.innerText);

    assert.ok(text.includes('差 269 題'), `缺少差額提示;實際:\n${text.slice(0, 400)}`);
    assert.ok(text.includes('每天多'), '缺少「每天多 N 題」的建議');
    assert.ok(text.includes('不寫 110 年'), '缺少「砍最舊年份」的建議');
    assert.ok(text.includes('改成 2 輪'), '缺少「少一輪」的建議');
    assert.ok(text.includes('下載計畫表'), '缺少下載按鈕');

    // 回頭改答案:點已回答的氣泡應該回到那一題,而不是整個對話重來。
    await dialog.getByRole('button', { name: '3 輪', exact: true }).click();
    await dialog.getByRole('button', { name: '1 輪', exact: true }).waitFor({ timeout: 5_000 });

    assert.equal(
      errors.length,
      0,
      `讀書計畫對話有未捕捉例外(WebKit):\n${errors.join('\n---\n')}`,
    );
  } finally {
    await ctx.close();
  }
});

// 連點標題解鎖隱藏年份(103)。
//
// 純函式那層(src/lib/secretUnlock.test.ts)驗的是「第 7 下才觸發、窗口多寬」;
// 這裡驗的是**接線**:onClick 真的掛在 h1 上、localStorage 真的寫進去、年份清單
// 真的多一列、換頁之後還在。兩層互相看不到 —— 狀態機全綠但 onClick 沒掛上去,
// 使用者看到的是「這招沒有用」,而所有單元測試照樣是綠的。
//
// fixture 的 questions__meta_years.json 帶著 {"year":103,"count":42} —— 正式站
// 真的長這樣。少了那一列,這支的每一條都會退化成恆真。
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
const TAPS = 7;

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
    skipReason = `WebKit 起不來:${e.message.split('\n')[0]}`;
    return;
  }
  server = await startServer({ dist: DIST });
});

after(async () => {
  if (server) await server.close();
  if (browser) await browser.close();
});

async function open(path_) {
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
  await page.goto(`${server.origin}${path_}`);
  return { ctx, page, errors };
}

/** 點 n 下標題。先等標題出現 —— 少了這一步,選擇器一腐爛整支就變成空掃的綠燈。 */
async function tap(page, name, times = TAPS) {
  const h1 = page.getByRole('heading', { name, exact: true });
  await h1.waitFor({ state: 'visible' });
  for (let i = 0; i < times; i++) await h1.click();
}

/** 年份清單真的畫出來了 —— 沒有這個對照,「看不到 103」是恆真的。 */
async function yearsRendered(page) {
  await page.locator('a[href^="/year/"]').first().waitFor({ state: 'visible' });
}

function guard(t) {
  if (!skipReason) return false;
  if (REQUIRE) assert.fail(`E2E_REQUIRE=1 但無法執行:${skipReason}`);
  t.skip(skipReason);
  return true;
}

test('複習模式:預設看不到 103,連點 7 下就出現而且標明不完整', async (t) => {
  if (guard(t)) return;
  const { ctx, page, errors } = await open('/review');
  try {
    await yearsRendered(page);
    assert.equal(await page.locator('a[href="/year/103"]').count(), 0, '預設不該有 103');

    await tap(page, '複習模式');
    const card = page.locator('a[href="/year/103"]').first();
    await card.waitFor({ state: 'visible' });

    // 只是「出現」還不夠 —— 沒有這一行,使用者會以為那年真的只考 42 題。
    const text = await card.innerText();
    assert.match(text, /不完整/);
    assert.match(text, /42/);
    assert.deepEqual(errors, []);
  } finally {
    await ctx.close();
  }
});

// ⚠️ 這條是負面斷言,**功能整個壞掉時它也會通過** —— 停用驗證時實測只有它留綠。
// 它的話語權來自同檔上面那條正面對照(點 7 下真的會出現);單獨看它沒有意義。
test('點 6 下不解鎖 —— 少一下就是沒有', async (t) => {
  if (guard(t)) return;
  const { ctx, page } = await open('/review');
  try {
    await yearsRendered(page);
    await tap(page, '複習模式', TAPS - 1);
    assert.equal(await page.locator('a[href="/year/103"]').count(), 0);
  } finally {
    await ctx.close();
  }
});

test('解鎖是全站的:複習模式點開,全真作答那頁也看得到', async (t) => {
  if (guard(t)) return;
  const { ctx, page } = await open('/review');
  try {
    await yearsRendered(page);
    await tap(page, '複習模式');
    await page.locator('a[href="/year/103"]').first().waitFor({ state: 'visible' });

    await page.goto(`${server.origin}/exam`);
    await page.getByRole('heading', { name: '全真作答', exact: true }).waitFor();
    // 對照組:先確認那一頁的年份鈕真的畫出來了。
    await page.locator('button', { hasText: '114' }).first().waitFor({ state: 'visible' });
    assert.equal(
      await page.locator('button', { hasText: '103' }).count() > 0,
      true,
      '另一頁應該跟著看得到',
    );
  } finally {
    await ctx.close();
  }
});

test('再點 7 下就收回去 —— 同一個手勢兩個方向', async (t) => {
  if (guard(t)) return;
  const { ctx, page } = await open('/review');
  try {
    await yearsRendered(page);
    await tap(page, '複習模式');
    await page.locator('a[href="/year/103"]').first().waitFor({ state: 'visible' });
    await tap(page, '複習模式');
    await page.waitForFunction(
      () => !document.querySelector('a[href="/year/103"]'),
      null,
      { timeout: 5000 },
    );
  } finally {
    await ctx.close();
  }
});

test('重新載入之後仍然解鎖(存 localStorage,不是元件狀態)', async (t) => {
  if (guard(t)) return;
  const { ctx, page } = await open('/review');
  try {
    await yearsRendered(page);
    await tap(page, '複習模式');
    await page.locator('a[href="/year/103"]').first().waitFor({ state: 'visible' });
    await page.reload();
    await page.locator('a[href="/year/103"]').first().waitFor({ state: 'visible' });
  } finally {
    await ctx.close();
  }
});

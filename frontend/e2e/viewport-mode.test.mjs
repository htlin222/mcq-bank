// 「強制手機版面」FAB(#94)。
//
// 為什麼是 e2e 而不是單元測試:唯一值得驗的純函式住在 lib/viewportMode.ts,而那支
// 為了拿 localStorage key 會 import `../config` —— 那是 Vite 在建置時注入的
// `__APP_CONFIG__`,在 `node --test` 底下模組根本載不起來(同 questionCache 的
// 情況)。與其為三行字串再拆一個模組,在真的建置產物上驗更划算:它連「按鈕在不在」
// 「meta 有沒有真的被改寫」「重整後還在不在」一起蓋掉,而那三件事沒有一件是純函式
// 測得到的。
//
// 桌機瀏覽器完全忽略 viewport meta,所以驗的是**我們寫進 meta 的內容**,不是版面
// 真的縮了 —— 後者只有行動引擎做得到,而 iPhone 13 這個 device profile 提供的正是
// `(pointer: coarse)`(FAB 的出現條件)。
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
let devices;
let skipReason = null;

before(async () => {
  if (!fs.existsSync(path.join(DIST, 'index.html'))) {
    skipReason = `找不到 ${DIST}/index.html —— 先跑 pnpm --dir frontend build`;
    return;
  }
  let webkit;
  try {
    ({ webkit, devices } = await import('playwright'));
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

const content = (page) =>
  page.getAttribute('meta[name="viewport"]', 'content');

test('觸控裝置:FAB 把 viewport 換成固定寬度,並且撐過重整', async (t) => {
  if (skipReason) {
    if (REQUIRE) assert.fail(`E2E_REQUIRE=1 但無法執行:${skipReason}`);
    return t.skip(skipReason);
  }

  const ctx = await browser.newContext(devices['iPhone 13']);
  const page = await ctx.newPage();
  try {
    await page.goto(server.origin + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1_500);

    assert.match(
      await content(page),
      /width=device-width/,
      '預設就不是 device-width —— 沒按按鈕就已經被改掉了',
    );

    const fab = page.getByRole('button', { name: '強制手機版面' });
    assert.equal(await fab.count(), 1, '觸控裝置上找不到那顆 FAB');
    await fab.click();
    // 等的比 300ms 久,是因為 ViewportModeFab 在點擊後 300ms 會量一次寬度,量到
    // 沒變就重新載入(見那裡的說明)。Playwright 兩個引擎都把版面視窗釘死,所以
    // 這條補救路徑在測試裡**一定**會走到 —— 短等會讀到重整途中的狀態。
    await page.waitForTimeout(1_500);

    const forced = await content(page);
    const m = /width=(\d+)/.exec(forced);
    assert.ok(m, `按下去之後 viewport 仍然沒有固定寬度:${forced}`);
    // < md(768)才拿得到手機版面,< sm(640)底部導覽列才會回來 —— 而底部列是
    // 手機版唯一的導覽。任何一邊沒滿足,這功能就只做了一半,而且無聲。
    assert.ok(Number(m[1]) < 640, `寬度 ${m[1]} 沒有小於 sm(640),底部導覽列不會回來`);
    assert.ok(Number(m[1]) < 768, `寬度 ${m[1]} 沒有小於 md(768),仍然是桌機版面`);
    // 少了 viewport-fit=cover,瀏海機的 safe-area inset 會歸零,底部導覽列被
    // 系統手勢條吃掉一截 —— 只有在那種機器上才看得出來,所以這裡鎖住。
    assert.match(forced, /viewport-fit=cover/);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1_500);
    assert.equal(await content(page), forced, '重整後偏好沒有留下來');

    // 切得回去 —— 一個切得過去、切不回來的開關比沒有更糟。
    await page.getByRole('button', { name: '回到自動版面' }).click();
    await page.waitForTimeout(1_500);
    assert.match(await content(page), /width=device-width/);
  } finally {
    await ctx.close();
  }
});

test('桌機:不顯示那顆 FAB(viewport meta 在桌機瀏覽器是沒作用的)', async (t) => {
  if (skipReason) {
    if (REQUIRE) assert.fail(`E2E_REQUIRE=1 但無法執行:${skipReason}`);
    return t.skip(skipReason);
  }

  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  try {
    await page.goto(server.origin + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1_500);
    assert.equal(
      await page.getByRole('button', { name: /手機版面|自動版面/ }).count(),
      0,
      '桌機上出現了一顆按下去不會有任何反應的按鈕',
    );
  } finally {
    await ctx.close();
  }
});

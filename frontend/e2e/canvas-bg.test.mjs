// canvas 背景與 theme-color 要跟著**套用中的主題**走(#131)。
//
// iOS Safari 往上拉超過頂端(橡皮筋回彈)時露出的那一塊,畫的是 canvas 的背景,
// 而 canvas 取的是 `<html>` 的 `background-color`。掛在 `<body>` 或任何內層
// `<div>` 上的背景一律看不到 —— 原本背景就在 body 的一個靜態 `bg-ink-50` 上,
// 沒有深色版本,所以深色模式下回彈露出一片淺米色。
//
// `mobileChrome.test.ts` 已經靜態掃過「規則寫在 :root 上」,這支補的是另一半:
// **算出來真的是那個顏色**。靜態掃描看不到 cascade —— 只要有人在 body 或
// `#root` 上補一個不透明背景,回彈區就又壞了,而規則本身還在。
//
// theme-color 一起驗:它由 `applyTheme()` 動態改寫,而 #126 一度加了兩條
// `media` 版本,害 `querySelector` 拿到「只在系統淺色時生效」的那一條 ——
// 手動切主題再也染不到狀態列,完全無聲。
//
//   pnpm test:webkit
//
// 沒安裝 playwright / webkit 時預設跳過;CI 設 E2E_REQUIRE=1 改為失敗。

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(HERE, '..', 'dist');
const REQUIRE = process.env.E2E_REQUIRE === '1';
const THEME_KEY = 'hema-2026:theme';

// 期望值跟 App.tsx 最外層的 `bg-ink-50 dark:bg-ink-900` 對齊 —— 回彈區與頁面
// 同色才看不出接縫。
const CASES = [
  { theme: 'light', bg: 'rgb(247, 245, 242)', scheme: 'light', tint: '#ffffff' },
  { theme: 'dark', bg: 'rgb(12, 10, 6)', scheme: 'dark', tint: '#1a160f' },
  { theme: 'eink', bg: 'rgb(255, 255, 255)', scheme: 'light', tint: '#ffffff' },
];

const PROBE = `
  (() => ({
    htmlBg: getComputedStyle(document.documentElement).backgroundColor,
    bodyBg: getComputedStyle(document.body).backgroundColor,
    colorScheme: getComputedStyle(document.documentElement).colorScheme,
    themeColor: document.querySelector('meta[name="theme-color"]')?.getAttribute('content'),
    metaCount: document.querySelectorAll('meta[name="theme-color"]').length,
  }))()
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

for (const c of CASES) {
  test(`canvas 背景與 theme-color:${c.theme}`, async (t) => {
    if (skipReason) {
      if (REQUIRE) assert.fail(`E2E_REQUIRE=1 但無法執行:${skipReason}`);
      return t.skip(skipReason);
    }

    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await ctx.addInitScript(
      ([k, v]) => localStorage.setItem(k, v),
      [THEME_KEY, c.theme],
    );
    const page = await ctx.newPage();
    await ctx.route('**/*', (r) =>
      r.request().url().startsWith(server.origin) ? r.continue() : r.abort(),
    );

    try {
      await page.goto(server.origin + '/q/113-050', {
        waitUntil: 'domcontentloaded',
        timeout: 30_000,
      });
      await page.waitForTimeout(900);
      const r = await page.evaluate(PROBE);

      assert.equal(r.htmlBg, c.bg, `${c.theme}:<html> 的背景不對 —— 回彈區會露出這個顏色`);
      // body 蓋一層不透明背景的話,html 那條就白設了(雖然回彈區仍然正確,但
      // 兩個來源遲早會分岔)。維持透明,單一來源。
      assert.equal(r.bodyBg, 'rgba(0, 0, 0, 0)', `${c.theme}:body 不該自帶背景`);
      assert.equal(r.colorScheme, c.scheme, `${c.theme}:color-scheme 不對(原生控制項會畫錯)`);
      assert.equal(r.metaCount, 1, 'theme-color 應該剛好一條 —— applyTheme 只會改寫第一條');
      assert.equal(r.themeColor, c.tint, `${c.theme}:狀態列顏色沒跟著主題走`);
    } finally {
      await ctx.close();
    }
  });
}

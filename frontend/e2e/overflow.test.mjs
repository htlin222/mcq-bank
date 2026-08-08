// 水平溢出守門:路由 × 寬度,斷言頁面本身**不會**左右捲動。
//
// 這支存在的理由是回報 #94:「有些會觸發 left/right scroll 導致有東西溢出,我不要
// 有 left / right scroll」。查出來的成因是 header 的導覽階梯 —— 每一階項目都比
// 「塞得下的寬度」早一個斷點出現,所以 **斷點本身那一刻最擠**:640(sm,導覽整條
// 冒出來)、768(md,再多兩項)必定溢出,320 則是連品牌 + 工具列都塞不下。
//
// 因此寬度清單刻意繞著斷點取樣(639/640、767/768、1023/1024、1279/1280):在
// 中間值量是量不到的,那正是這個 bug 活這麼久的原因 —— 常用的 390/414/1440 全都
// 剛好沒事。加新斷點時請把它的兩側一起加進來。
//
// 只認**頁面層級**的捲動(documentElement.scrollWidth > clientWidth)。內部自己
// 捲的容器(`overflow-x:auto` 的寬表格、程式碼區塊)是刻意的設計,不算。
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

const ROUTES = ['/', '/year/113', '/q/113-050', '/review', '/videos', '/play'];
const WIDTHS = [320, 360, 639, 640, 700, 767, 768, 820, 1023, 1024, 1279, 1280];

// 頁面層級溢出時,回報「最外層」的元凶 —— 父層已經被帶出去的話,子層只是跟著跑,
// 列出來只會把真正該修的那一個淹掉。position:fixed 不參與頁面捲動,跳過。
const PROBE = `
  (() => {
    const de = document.documentElement;
    const vw = de.clientWidth;
    const over = de.scrollWidth - vw;
    if (over <= 0) return { over: 0, bad: [] };
    const bad = [];
    for (const el of document.querySelectorAll('body *')) {
      if (getComputedStyle(el).position === 'fixed') continue;
      if (!el.getClientRects().length) continue;
      const r = el.getBoundingClientRect();
      if (r.right <= vw + 1 && r.left >= -1) continue;
      const p = el.parentElement;
      if (p) {
        const pr = p.getBoundingClientRect();
        if (pr.right > vw + 1 || pr.left < -1) continue;
      }
      bad.push(el.tagName + '.' + String(el.className).trim().split(/\\s+/).slice(0, 4).join('.'));
    }
    return { over, bad: [...new Set(bad)].slice(0, 5) };
  })()
`;

let browser;
let server;
let skipReason = null;
let THEME_KEY;

before(async () => {
  const toml = fs.readFileSync(path.join(HERE, '..', '..', 'config.toml'), 'utf8');
  const m = /^\s*theme_storage_key\s*=\s*"([^"]+)"/m.exec(toml);
  assert.ok(m, 'config.toml 找不到 theme_storage_key');
  THEME_KEY = m[1];

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

for (const width of WIDTHS) {
  test(`不產生水平捲動:${width}px`, async (t) => {
    if (skipReason) {
      if (REQUIRE) assert.fail(`E2E_REQUIRE=1 但無法執行:${skipReason}`);
      return t.skip(skipReason);
    }

    const ctx = await browser.newContext({ viewport: { width, height: 900 } });
    await ctx.addInitScript((k) => localStorage.setItem(k, 'light'), THEME_KEY);
    const page = await ctx.newPage();
    await ctx.route('**/*', (r) =>
      r.request().url().startsWith(server.origin) ? r.continue() : r.abort(),
    );

    const offenders = [];
    try {
      for (const route of ROUTES) {
        await page.goto(server.origin + route, {
          waitUntil: 'domcontentloaded',
          timeout: 30_000,
        });
        await page.waitForTimeout(600);
        const r = await page.evaluate(PROBE);
        if (r.over > 0) offenders.push(`${route} 超出 ${r.over}px ← ${r.bad.join(' , ')}`);
      }
      assert.deepEqual(offenders, [], `${width}px 有頁面層級的水平捲動`);
    } finally {
      await ctx.close();
    }
  });
}

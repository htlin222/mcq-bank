// 浮動按鈕(FAB)守門:任何一顆 FAB 都不准壓在手機底部導覽列上。
//
// 這支存在的理由是番茄鐘 FAB 的 `sm:bottom-6`:它是「底部導覽列到 `sm` 為止」那個
// 年代留下來的。#94 把導覽列延到 `md`(640–767 那一段上面那條 header 放不下,由它
// 接手)之後,`--bottom-nav-h` 跟著改成 `max-width: 767px` 才有值,但 FAB 的斷點沒
// 有一起改 —— 於是 640–767 這一整段,番茄鐘剛好蓋住導覽列最右邊那顆(收藏)。
//
// 兩個教訓寫進這支測試的形狀裡:
//
//   1. **寬度繞著斷點取樣**(同 overflow.test.mjs)。639/640 與 767/768 兩組跨線,
//      中間值量不到 —— 390/414 剛好都在安全區,所以這個 bug 活了下來。
//   2. **先斷言「找得到導覽列、找得到番茄鐘」再斷言不重疊。** 少了前半段,選擇器
//      腐爛(改 aria-label、FAB 不再渲染)會讓這支變成一路綠燈的空測試。
//
// 只認 `position: fixed` 的祖先鏈:跟著頁面捲動的元素捲過導覽列不算遮擋,
// 導覽列自己的五顆按鈕當然也不算(用 `nav.contains` 排掉)。
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

// 導覽列只在 <md 出現,所以 768 是「導覽列不在了」的對照組 —— 它驗的是這支測試
// 本身沒有把「沒有導覽列」誤判成「沒有重疊」。
const WIDTHS = [360, 560, 639, 640, 700, 767, 768];
const ROUTE = '/q/113-050';

const PROBE = `
  (() => {
    const nav = [...document.querySelectorAll('nav')].find(
      (n) => getComputedStyle(n).position === 'fixed' && n.getClientRects().length,
    );
    const isPinned = (el) => {
      for (let f = el; f && f !== document.body; f = f.parentElement) {
        if (getComputedStyle(f).position === 'fixed') return true;
      }
      return false;
    };
    const label = (el) =>
      (el.getAttribute('aria-label') || el.textContent || el.tagName).trim().slice(0, 30);

    const fabs = [];
    for (const el of document.querySelectorAll('button, a')) {
      if (nav && nav.contains(el)) continue;
      if (!el.getClientRects().length) continue;
      if (!isPinned(el)) continue;
      const r = el.getBoundingClientRect();
      fabs.push({ label: label(el), top: r.top, bottom: r.bottom, left: r.left, right: r.right });
    }

    if (!nav) return { hasNav: false, fabs, hits: [] };
    const nr = nav.getBoundingClientRect();
    const hits = fabs
      .filter(
        (f) =>
          Math.min(f.bottom, nr.bottom) - Math.max(f.top, nr.top) > 0 &&
          Math.min(f.right, nr.right) - Math.max(f.left, nr.left) > 0,
      )
      .map((f) => f.label + ' 壓住導覽列(FAB ' + Math.round(f.top) + '–' + Math.round(f.bottom) +
        ' vs nav ' + Math.round(nr.top) + '–' + Math.round(nr.bottom) + ')');
    return { hasNav: true, fabs, hits };
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

for (const width of WIDTHS) {
  test(`FAB 不壓住底部導覽列:${width}px`, async (t) => {
    if (skipReason) {
      if (REQUIRE) assert.fail(`E2E_REQUIRE=1 但無法執行:${skipReason}`);
      return t.skip(skipReason);
    }

    // `hasTouch` / `isMobile` 是「強制手機版面」FAB 的出現條件((pointer: coarse)),
    // 少了它那一顆根本不渲染,左下角那一疊就掃不到。
    const ctx = await browser.newContext({
      viewport: { width, height: 820 },
      hasTouch: true,
      isMobile: true,
      deviceScaleFactor: 2,
    });
    const page = await ctx.newPage();
    await ctx.route('**/*', (r) =>
      r.request().url().startsWith(server.origin) ? r.continue() : r.abort(),
    );

    try {
      await page.goto(server.origin + ROUTE, {
        waitUntil: 'domcontentloaded',
        timeout: 30_000,
      });
      await page.waitForTimeout(600);
      // 捲到底:回到最頂那顆只有捲過一段之後才出現,而那正是三顆同時在畫面上的時候。
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(400);

      const r = await page.evaluate(PROBE);

      // 沒抓到番茄鐘就代表這支在空掃 —— 寧可紅,不要靜靜地綠。
      assert.ok(
        r.fabs.some((f) => f.label.includes('番茄鐘')),
        `${width}px 找不到番茄鐘 FAB,掃到的是:${r.fabs.map((f) => f.label).join(' , ') || '(無)'}`,
      );
      assert.equal(
        r.hasNav,
        width < 768,
        `${width}px 底部導覽列的有無跟預期不符(md 以上不該有)`,
      );
      assert.deepEqual(r.hits, [], `${width}px 有 FAB 壓在底部導覽列上`);
    } finally {
      await ctx.close();
    }
  });
}

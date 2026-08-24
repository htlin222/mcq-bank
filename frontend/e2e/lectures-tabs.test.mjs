// /lectures 的分頁列不准隨著切換左右漂移(#111)。
//
// 原本標題與分頁列同一條 flex row,而標題就是當前分頁的名字 ——
// 「複習班講義」/「Wintrobe 教科書」/「其他筆記」/「書籤」字寬各不相同,所以每按一次
// 分頁,整條分頁列就跟著標題的寬度往左右跳一段。使用者的描述是「標題在改動時,
// 就會一直 x position 漂來漂去」。
//
// 這支測的形狀有兩個刻意的地方:
//
//   1. **先斷言「三顆分頁都在、而且點得動」**(標題真的跟著換)。少了這半段,
//      選擇器一腐爛就退化成「量到 0 個元素 → 沒有漂移 → 綠燈」。
//   2. 量的是 `[role=tablist]` 的 left,不是個別按鈕 —— 按鈕自己的寬度不會變,
//      會動的是整條的起點。
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

// 桌機與手機各量一次。抓到 bug 的是 1280 —— 390 底下 flex-wrap 本來就把分頁列
// 擠到自己一行,所以它是對照組:證明這支測的不是「窄螢幕剛好會換行」。
const VIEWPORTS = [
  { width: 1280, height: 900 },
  { width: 390, height: 844 },
];

const PROBE = `
  (() => {
    const strip = document.querySelector('[role="tablist"]');
    const h1 = document.querySelector('h1');
    return {
      left: strip ? Math.round(strip.getBoundingClientRect().left) : null,
      top: strip ? Math.round(strip.getBoundingClientRect().top) : null,
      tabs: strip
        ? [...strip.querySelectorAll('[role="tab"]')].map((b) => b.textContent.trim())
        : [],
      title: h1 ? h1.textContent.trim() : null,
    };
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

for (const viewport of VIEWPORTS) {
  test(`/lectures 分頁列切換時不左右漂移:${viewport.width}px`, async (t) => {
    if (skipReason) {
      if (REQUIRE) assert.fail(`E2E_REQUIRE=1 但無法執行:${skipReason}`);
      return t.skip(skipReason);
    }

    const ctx = await browser.newContext({ viewport });
    const page = await ctx.newPage();
    await ctx.route('**/*', (r) =>
      r.request().url().startsWith(server.origin) ? r.continue() : r.abort(),
    );

    try {
      await page.goto(server.origin + '/lectures', {
        waitUntil: 'domcontentloaded',
        timeout: 30_000,
      });
      await page.waitForSelector('[role="tablist"] [role="tab"]', { timeout: 15_000 });
      await page.waitForTimeout(300);

      const first = await page.evaluate(PROBE);

      // 空掃防線:四顆分頁都要在。
      assert.equal(
        first.tabs.length,
        4,
        `找不到四顆分頁,掃到的是:${JSON.stringify(first.tabs)}`,
      );

      const seen = [{ ...first }];
      for (let i = 1; i < first.tabs.length; i++) {
        await page.click(`[role="tablist"] [role="tab"] >> nth=${i}`);
        await page.waitForTimeout(250);
        seen.push(await page.evaluate(PROBE));
      }

      // 空掃防線之二:點下去要真的換分頁(標題跟著變),否則「沒漂移」毫無意義。
      const titles = seen.map((s) => s.title);
      assert.equal(
        new Set(titles).size,
        4,
        `切換分頁後標題沒有跟著換,量到:${JSON.stringify(titles)}`,
      );

      const lefts = seen.map((s) => s.left);
      assert.equal(
        new Set(lefts).size,
        1,
        `分頁列左緣隨分頁漂移:${titles
          .map((t2, i) => `${t2}=${lefts[i]}px`)
          .join(' , ')}`,
      );
    } finally {
      await ctx.close();
    }
  });
}

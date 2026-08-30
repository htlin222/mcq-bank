// 考試中的計時列不能被 app header 蓋住(#139)。
//
// 這條的成因是兩個各自都正確的決定撞在一起:app header 是 `fixed top-0 z-30`
// 且不透明,而計時列是 `sticky top-0 z-10` 又跟著 window 捲 —— 於是它「黏住」的
// 位置正好在 header 底下。捲回頂端又會出現,所以看起來像隨機故障。
//
// **靜態掃描抓不到這個形狀**:`sticky top-0` 本身沒有錯,同一份程式碼裡另外兩處
// (講義閱讀器的工具列、全螢幕筆記卡)都是對的 —— 它們在自己的捲動容器裡,而那些
// 容器的頂端本來就在 header 底下。錯的只有「跟著 window 捲的那一種」,而那要
// 真的排版才分得出來。
//
//   pnpm test:webkit

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './server.mjs';

// `running_since` 是絕對時間戳,所以**靜態 fixture 給什麼都會過期**:給過去的時間,
// client 算出來早就超過 100 分鐘上限,一進頁面就自動交卷;給 null(暫停)則整份
// 題目不渲染,頁面只剩「已暫停作答」四個字、捲不動。
//
// 所以 fixture 只提供形狀,「現在」由測試在請求當下注入。這也是它為什麼不能寫死
// 在 fixtures/ 裡的原因。
const STATE = JSON.parse(
  fs.readFileSync(
    path.join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures', 'exam_e2e-1_state.json'),
    'utf8',
  ),
);

async function serveFreshState(ctx) {
  await ctx.route('**/api/exam/e2e-1/state', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify({ ...STATE, running_since: Date.now(), elapsed_ms: 60_000 }),
    }),
  );
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(HERE, '..', 'dist');
const REQUIRE = process.env.E2E_REQUIRE === '1';

// 繞著版型取樣:桌機雙欄與手機分頁的 header 高度、計時列高度都不同,
// 而這個 bug 在兩邊的嚴重程度也不一樣(桌機整條沒入,手機露出下緣一截)。
//
// 高度刻意壓矮:1280×800 底下這一頁只捲得動 56px,「捲動後」跟「捲動前」是同一個
// 狀態,斷言就恆真了 —— 跟 note-fullscreen 的 squash 同一個前提。下面有一條
// 前置斷言把這件事變成紅燈而不是假綠。
const VIEWPORTS = [
  { name: '手機', width: 390, height: 700, mobile: true },
  { name: '桌機', width: 1280, height: 520, mobile: false },
];

const PROBE = `
  (() => {
    const hs = [...document.querySelectorAll('header')];
    const app = hs.find((h) => h.className.includes('app-chrome-top'));
    const bar = hs.find((h) => h !== app);
    if (!app || !bar) return { hasApp: !!app, hasBar: !!bar };
    const b = bar.getBoundingClientRect();
    const a = app.getBoundingClientRect();
    // 計時列正中央那一點,畫面最上層畫的是誰?被 header 蓋住時會落在 header 裡面。
    const el = document.elementFromPoint(
      Math.round(b.left + b.width / 2),
      Math.round(b.top + b.height / 2),
    );
    return {
      hasApp: true,
      hasBar: true,
      text: bar.textContent.trim().slice(0, 40),
      barTop: Math.round(b.top),
      appBottom: Math.round(a.bottom),
      coveredByHeader: el ? app.contains(el) : false,
      scrollY: Math.round(window.scrollY),
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

for (const vp of VIEWPORTS) {
  test(`考試計時列不被 header 蓋住:${vp.name} ${vp.width}px`, async (t) => {
    if (skipReason) {
      if (REQUIRE) assert.fail(`E2E_REQUIRE=1 但無法執行:${skipReason}`);
      return t.skip(skipReason);
    }

    const ctx = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      ...(vp.mobile ? { isMobile: true, hasTouch: true } : {}),
    });
    await serveFreshState(ctx);
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));

    try {
      await page.goto(server.origin + '/exam/e2e-1', {
        waitUntil: 'domcontentloaded',
        timeout: 30_000,
      });
      await page.waitForTimeout(1200);

      const top = await page.evaluate(PROBE);
      // 空掃防線:計時列渲染不出來的話,底下每一條都恆真。
      assert.ok(top.hasApp, '找不到 app header');
      assert.ok(top.hasBar, '找不到考試計時列 —— fixture 沒讓考試頁渲染出來');
      assert.match(top.text, /交卷/, `這條不像計時列:${top.text}`);
      assert.ok(top.barTop >= top.appBottom - 1, '還沒捲動就已經被蓋住了');

      // 對照組:這一頁真的要捲得動,否則「捲動後」跟「捲動前」是同一個狀態,
      // 底下的斷言全部恆真。
      const scrollable = await page.evaluate(
        () => document.documentElement.scrollHeight - window.innerHeight,
      );
      assert.ok(scrollable > 200, `這一頁只捲得動 ${scrollable}px,量不到 sticky 黏住之後的位置`);

      // 捲夠遠,讓 sticky 真的黏住(這正是舊版出事的狀態)。
      await page.evaluate(() => window.scrollTo(0, 900));
      await page.waitForTimeout(400);

      const after_ = await page.evaluate(PROBE);
      assert.ok(after_.scrollY > 100, `頁面沒有真的捲動(scrollY=${after_.scrollY})`);
      assert.ok(
        after_.barTop >= after_.appBottom - 1,
        `捲動後計時列鑽到 header 底下:bar top=${after_.barTop},header bottom=${after_.appBottom}`,
      );
      assert.equal(
        after_.coveredByHeader,
        false,
        '計時列中央被 app header 蓋住 —— 考試中往下捲就看不到剩餘時間與交卷',
      );
      assert.deepEqual(errors, []);
    } finally {
      await ctx.close();
    }
  });
}

test('暫停時不再顯示「暫停中」badge —— 主畫面已經整個換成暫停面板了', async (t) => {
  if (skipReason) {
    if (REQUIRE) assert.fail(`E2E_REQUIRE=1 但無法執行:${skipReason}`);
    return t.skip(skipReason);
  }

  const ctx = await browser.newContext({
    viewport: { width: 390, height: 700 },
    isMobile: true,
    hasTouch: true,
    serviceWorkers: 'block',
  });
  // running_since: null = 暫停中。
  await ctx.route('**/api/exam/e2e-1/state', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify({ ...STATE, running_since: null, elapsed_ms: 60_000 }),
    }),
  );
  const page = await ctx.newPage();
  try {
    await page.goto(server.origin + '/exam/e2e-1', { waitUntil: 'domcontentloaded' });

    // ⚠️ **對照組:先證明真的在暫停狀態。** 「badge 不在」是負面斷言 ——
    // 頁面沒載出來、或 fixture 形狀不對時它也會成立。
    await page.locator('text=已暫停作答').first().waitFor({ timeout: 20_000 });
    await page.locator('button', { hasText: '繼續作答' }).first().waitFor({ timeout: 5_000 });

    const body = await page.locator('body').innerText();
    assert.ok(
      !body.includes('暫停中'),
      '暫停時不該再有「暫停中」badge —— 同一個狀態已經由暫停面板、工具列的「繼續」鈕講過了',
    );
  } finally {
    await ctx.close();
  }
});

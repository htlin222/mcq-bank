// 分頁列的尾端摺疊,以及筆記工具的 responsive 形態(#137 後續)。
//
// 兩者是同一個判準(`useNarrow`,<sm)的兩個用途,所以放一起 —— 改斷點時會一起紅。
//
// **這種「窄的時候收起來」的東西一定要繞著斷點兩側取樣**:只測 390 的話,把條件
// 寫成「永遠收」也會全綠(CLAUDE.md 導覽階梯那節的教訓)。
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

// 分頁列 = 直接子節點裡有一顆文字剛好是「題目」的按鈕的那個容器。
// 用 class 找會在改樣式時腐爛成空掃的綠燈。
const STRIP = `
  (() => {
    const strip = [...document.querySelectorAll('div')].find((d) =>
      [...d.children].some((c) => c.tagName === 'BUTTON' && c.textContent.trim() === '題目'));
    if (!strip) return null;
    const r = strip.getBoundingClientRect();
    const first = strip.querySelector('button').getBoundingClientRect();
    const more = document.querySelector('[aria-label^="更多分頁"]');
    return {
      inline: [...strip.children]
        .filter((c) => c.tagName === 'BUTTON')
        .map((b) => b.textContent.trim()),
      // 折行的話整條會變成兩倍高。比高度而不是比每個子節點的 top ——
      // 子節點高度本來就不一樣(徽章、計數),top 不對齊不代表折行。
      //
      // ⚠️ 門檻用倍率不用「+6px」:實測單行是 48.4 而按鈕是 42,寫死的餘裕差一點
      // 就假紅(我第一版就是,而手動量測時的四捨五入讓它看起來剛好通過)。
      // 這一段在 template literal 裡,所以註解不能用反引號 —— 會把字串關掉。
      // 單行 ~48、兩行 ~90,1.6 倍在中間很安全。
      oneRow: r.height < first.height * 1.6,
      heights: [Math.round(r.height), Math.round(first.height)],
      moreLabel: more ? more.getAttribute('aria-label') : null,
      docOverflow: document.documentElement.scrollWidth - window.innerWidth,
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

function guard(t) {
  if (!skipReason) return false;
  if (REQUIRE) throw new Error(skipReason);
  t.skip(skipReason);
  return true;
}

async function open(width) {
  const ctx = await browser.newContext({
    viewport: { width, height: 900 },
    isMobile: true,
    hasTouch: true,
  });
  const page = await ctx.newPage();
  await page.goto(server.origin + '/q/113-050', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(900);
  return { ctx, page };
}

test('<sm:尾端三個分頁摺進 ⋮,列維持一行', async (t) => {
  if (guard(t)) return;
  const { ctx, page } = await open(390);
  const s = await page.evaluate(STRIP);

  assert.ok(s, '找不到分頁列 —— 選擇器腐爛了,這條測試沒在驗東西');
  assert.deepEqual(s.inline, ['題目', '詳解', '個人筆記●']);
  assert.equal(s.moreLabel, '更多分頁(3)', '討論串 / 相似題目 / 影片 應該被摺起來');
  assert.ok(s.oneRow, `分頁列折行了 —— 摺疊沒有生效(列高 ${s.heights[0]},按鈕高 ${s.heights[1]})`);
  assert.equal(s.docOverflow, 0);

  await ctx.close();
});

test('≥sm:六個分頁全部在列上,沒有 ⋮', async (t) => {
  if (guard(t)) return;
  // 對照組。少了它,把條件寫成「永遠收起來」也會全綠。
  const { ctx, page } = await open(640);
  const s = await page.evaluate(STRIP);

  assert.ok(s, '找不到分頁列');
  assert.equal(s.moreLabel, null, '640px 塞得下,不該有溢出選單');
  assert.deepEqual(s.inline, ['題目', '詳解', '個人筆記●', '討論串(0)', '相似題目(0)', '影片(2)']);
  assert.ok(s.oneRow, `640px 的分頁列折行了(列高 ${s.heights[0]},按鈕高 ${s.heights[1]})`);

  await ctx.close();
});

test('從 ⋮ 挑一個分頁之後,它要留在列上', async (t) => {
  if (guard(t)) return;
  // 少了這條保證,挑完「影片」之後六個分頁沒有一個是亮的 —— 看不出自己在哪。
  const { ctx, page } = await open(390);

  await page.click('[aria-label^="更多分頁"]');
  await page.waitForTimeout(250);
  const items = await page.evaluate(
    () => [...document.querySelectorAll('[role="menuitem"]')].map((e) => e.textContent.trim()),
  );
  assert.deepEqual(items, ['討論串(0)', '相似題目(0)', '影片(2)']);

  await page.locator('[role="menuitem"]', { hasText: '影片' }).first().click();
  await page.waitForTimeout(400);

  const s = await page.evaluate(STRIP);
  assert.ok(s.inline.some((l) => l.startsWith('影片')), `影片沒有留在列上:${s.inline}`);
  assert.equal(s.moreLabel, '更多分頁(2)', '摺起來的應該少一項');
  assert.ok(s.oneRow, `影片補上去之後折行了(列高 ${s.heights[0]})`);

  await ctx.close();
});

// ── 筆記工具的兩種形態 ──────────────────────────────────────

async function noteTools(width) {
  const ctx = await browser.newContext({
    viewport: { width, height: 900 },
    ...(width < 768 ? { isMobile: true, hasTouch: true } : {}),
  });
  const page = await ctx.newPage();
  await page.goto(server.origin + '/q/113-050', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(900);
  if (width < 768) {
    const tab = page.locator('button', { hasText: '詳解' }).first();
    if (await tab.count()) await tab.click().catch(() => {});
    await page.waitForTimeout(250);
  }
  await page.locator('button', { hasText: '個人筆記' }).first().click();
  await page.waitForTimeout(400);
  const r = await page.evaluate(() => ({
    more: !!document.querySelector('[aria-label="更多筆記工具"]'),
    inline: ['自動挖空', '防劇透', '編輯'].filter((t) =>
      [...document.querySelectorAll('button')].some((b) => b.textContent.trim().startsWith(t)),
    ),
    fullscreen: [...document.querySelectorAll('button')].some((b) =>
      b.textContent.trim().startsWith('全螢幕'),
    ),
  }));
  await ctx.close();
  return r;
}

test('筆記工具:窄螢幕收進「更多」,寬螢幕直接畫成按鈕', async (t) => {
  if (guard(t)) return;

  const narrow = await noteTools(390);
  assert.equal(narrow.more, true, '390px 應該收成「更多」');
  assert.deepEqual(narrow.inline, [], '收起來之後那三顆不該還在列上');
  assert.ok(narrow.fullscreen, '全螢幕不該被收進去 —— 它是每天都會按的那顆');

  const wide = await noteTools(1280);
  assert.equal(wide.more, false, '1280px 塞得下,不該收起來');
  assert.deepEqual(wide.inline, ['自動挖空', '防劇透', '編輯']);
  assert.ok(wide.fullscreen);
});

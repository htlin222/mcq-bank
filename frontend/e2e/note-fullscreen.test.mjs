// 個人筆記卡片的「全螢幕」(#115)。
//
// 刻意不用 Fullscreen API(iOS Safari 對非 <video> 的元素沒有 requestFullscreen),
// 所以驗的是**版面**:那張 <article> 有沒有真的長到整個視窗、退出後有沒有回到
// 原本的欄寬。
//
// 三個空掃防線:
//   1. 先斷言找得到那顆按鈕,而且點下去 aria-pressed 真的翻面。
//   2. 記下放大前的寬度並拿來比 —— 沒有基準的話「寬度等於視窗」在雙欄版型碰巧
//      成立時也會綠。
//   3. 順便驗筆記內文還在。DOM 沒有重掛是這個做法的重點(NoteContent/TipTap
//      重建正是 2026-07 iOS 白屏的成因),整塊消失要看得出來。
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

// 桌機(雙欄,筆記在右欄)與手機(分頁)各一次 —— 兩種版型下筆記卡的正常寬度
// 差很多,而全螢幕在兩邊都該是滿版。
const VIEWPORTS = [
  { width: 1280, height: 900, name: '桌機雙欄' },
  { width: 390, height: 844, name: '手機分頁' },
];

const PROBE = `
  (() => {
    const btn = [...document.querySelectorAll('button')].find(
      (b) => /全螢幕/.test(b.textContent || ''),
    );
    const card = btn ? btn.closest('article') : null;
    const r = card ? card.getBoundingClientRect() : null;
    return {
      hasBtn: !!btn,
      label: btn ? btn.textContent.trim() : null,
      pressed: btn ? btn.getAttribute('aria-pressed') : null,
      width: r ? Math.round(r.width) : null,
      height: r ? Math.round(r.height) : null,
      left: r ? Math.round(r.left) : null,
      top: r ? Math.round(r.top) : null,
      position: card ? getComputedStyle(card).position : null,
      hasBody: !!(card && /溶血/.test(card.textContent || '')),
    };
  })()
`;

async function openNoteTab(page, width) {
  // 手機是分頁版:先切到「題目以外」那一頁,筆記欄才會渲染出來。
  if (width < 768) {
    const tab = page.locator('button', { hasText: '詳解' }).first();
    if (await tab.count()) await tab.click().catch(() => {});
    await page.waitForTimeout(200);
  }
  const noteTab = page.locator('button', { hasText: '個人筆記' }).first();
  await noteTab.click();
  await page.waitForTimeout(400);
}

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
  test(`個人筆記全螢幕:${vp.name} ${vp.width}px`, async (t) => {
    if (skipReason) {
      if (REQUIRE) assert.fail(`E2E_REQUIRE=1 但無法執行:${skipReason}`);
      return t.skip(skipReason);
    }

    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await ctx.route('**/*', (r) =>
      r.request().url().startsWith(server.origin) ? r.continue() : r.abort(),
    );

    try {
      await page.goto(server.origin + '/q/113-050', {
        waitUntil: 'domcontentloaded',
        timeout: 30_000,
      });
      await page.waitForTimeout(600);
      await openNoteTab(page, vp.width);

      const before_ = await page.evaluate(PROBE);
      assert.ok(before_.hasBtn, '找不到「全螢幕」按鈕');
      assert.equal(before_.pressed, 'false');
      assert.ok(before_.hasBody, '筆記內文一開始就不在,後面的斷言沒有意義');
      assert.ok(
        before_.width < vp.width,
        `放大前筆記卡就已經滿版(${before_.width}px / 視窗 ${vp.width}px),量不出差別`,
      );

      await page.locator('button', { hasText: '全螢幕' }).first().click();
      await page.waitForTimeout(250);

      const on = await page.evaluate(PROBE);
      assert.equal(on.pressed, 'true');
      assert.equal(on.label, '離開全螢幕');
      assert.equal(on.position, 'fixed');
      assert.equal(on.left, 0);
      assert.equal(on.top, 0);
      assert.equal(on.width, vp.width, '全螢幕時寬度應該等於視窗');
      assert.equal(on.height, vp.height, '全螢幕時高度應該等於視窗');
      // DOM 沒有重掛 —— 內文還在同一張卡裡。
      assert.ok(on.hasBody, '放大後筆記內文不見了(卡片被重建?)');

      // Esc 退出:全螢幕遮住了導覽與上一題/下一題,這是唯一不必先找到按鈕的退路。
      await page.keyboard.press('Escape');
      await page.waitForTimeout(250);

      const off = await page.evaluate(PROBE);
      assert.equal(off.pressed, 'false', 'Esc 沒有退出全螢幕');
      assert.equal(off.width, before_.width, '退出後應該回到原本的欄寬');
      assert.ok(off.hasBody);

      assert.deepEqual(errors, [], '有未攔截的例外');
    } finally {
      await ctx.close();
    }
  });
}

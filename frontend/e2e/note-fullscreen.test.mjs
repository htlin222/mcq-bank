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

// ── 全螢幕時工具列黏在頂端(#122) ──────────────────────────────────────
//
// 這條要壓矮視窗才驗得到:預設高度下那則 fixture 筆記根本沒有東西可捲
// (scrollHeight === clientHeight),斷言「捲動後位置不變」會恆真 —— 跟
// gamepad.test.mjs 的 squash() 是同一個前提。
test('全螢幕:工具列黏在捲動區頂端,而且上方沒有縫', async (t) => {
  if (skipReason) {
    if (REQUIRE) assert.fail(`E2E_REQUIRE=1 但無法執行:${skipReason}`);
    return t.skip(skipReason);
  }

  const ctx = await browser.newContext({ viewport: { width: 1280, height: 300 } });
  const page = await ctx.newPage();
  await ctx.route('**/*', (r) =>
    r.request().url().startsWith(server.origin) ? r.continue() : r.abort(),
  );

  const bar = `
    (() => {
      const a = document.querySelector('article');
      // 用「全螢幕」認這一列:自動挖空/防劇透/編輯 在窄螢幕會收進「更多」、
      // 在寬螢幕直接畫成按鈕(#137 後續),只有全螢幕兩種形態都在列上。
      const tb = [...a.children].find((c) => /全螢幕/.test(c.textContent || ''));
      const r = tb.getBoundingClientRect();
      return {
        scrollTop: Math.round(a.scrollTop),
        scrollable: a.scrollHeight - a.clientHeight,
        top: Math.round(r.top),
        position: getComputedStyle(tb).position,
      };
    })()
  `;

  try {
    await page.goto(server.origin + '/q/113-050', {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });
    await page.waitForTimeout(600);
    await openNoteTab(page, 1280);
    await page.locator('button', { hasText: '全螢幕' }).first().click();
    await page.waitForTimeout(250);
    // 展開所有段落,製造可捲的內容。
    for (const h of await page.locator('[data-note-heading]').all()) {
      await h.click().catch(() => {});
    }
    await page.waitForTimeout(300);

    const top = await page.evaluate(bar);
    // 對照組:沒有東西可捲的話,下面那條斷言恆真。
    assert.ok(top.scrollable > 0, `卡片沒有可捲的內容(scrollable=${top.scrollable}),量不到黏不黏`);
    assert.equal(top.position, 'sticky');
    // 卡片上緣不留 padding,所以工具列的 border box 貼齊捲動區頂端 ——
    // 只差卡片自己那 1px 邊框。留了 padding 的話這裡會是 20–29px,而那道縫
    // 正是內文會透出來的地方。
    assert.ok(top.top <= 2, `工具列上方有 ${top.top}px 的縫,內文會從那裡透出來`);

    await page.evaluate(() => {
      document.querySelector('article').scrollTop = 9999;
    });
    await page.waitForTimeout(250);

    const bottom = await page.evaluate(bar);
    assert.ok(bottom.scrollTop > 0, '沒有真的捲動');
    assert.equal(bottom.top, top.top, '捲動後工具列跟著跑掉了 —— 沒有黏住');
  } finally {
    await ctx.close();
  }
});

// ── 刪除只在編輯模式出現(#121) ────────────────────────────────────────
test('個人筆記:唯讀工具列沒有刪除,按下編輯才有', async (t) => {
  if (skipReason) {
    if (REQUIRE) assert.fail(`E2E_REQUIRE=1 但無法執行:${skipReason}`);
    return t.skip(skipReason);
  }

  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await ctx.route('**/*', (r) =>
    r.request().url().startsWith(server.origin) ? r.continue() : r.abort(),
  );

  const countDelete = `
    [...document.querySelectorAll('button')].filter(
      (b) => /刪除/.test(b.textContent || '') && b.getClientRects().length,
    ).length
  `;

  try {
    await page.goto(server.origin + '/q/113-050', {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });
    await page.waitForTimeout(600);
    await openNoteTab(page, 1280);

    // 空掃防線:先確認真的在筆記面板上,否則「找不到刪除」只是因為整個面板沒渲染。
    //
    // 「編輯」有兩種形態(#137 後續):窄螢幕收在「更多」裡,寬螢幕直接是按鈕。
    // 這支跑 1280,所以走後者;但兩種都處理,寬度改了不會靜靜壞掉。
    const more = page.locator('[aria-label="更多筆記工具"]');
    let edit;
    if (await more.count()) {
      assert.equal(await page.evaluate(countDelete), 0, '唯讀狀態不該有刪除按鈕');
      await more.click();
      await page.waitForTimeout(250);
      edit = page.locator('[role="menuitem"]', { hasText: '編輯' }).first();
      assert.equal(await edit.count(), 1, '「更多」裡找不到編輯');
      // 開著選單時不該憑空冒出刪除 —— 少了這條,下面的斷言可能是選單自己帶來的。
      assert.equal(await page.evaluate(countDelete), 0, '選單裡不該有刪除');
    } else {
      edit = page.locator('button', { hasText: '編輯' }).first();
      assert.equal(await edit.count(), 1, '找不到「編輯」—— 沒有停在筆記面板上');
      assert.equal(await page.evaluate(countDelete), 0, '唯讀狀態不該有刪除按鈕');
    }

    await edit.click();
    await page.waitForTimeout(400);

    assert.ok(
      (await page.evaluate(countDelete)) >= 1,
      '進入編輯模式後找不到刪除按鈕',
    );
  } finally {
    await ctx.close();
  }
});

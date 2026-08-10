// 個人筆記卡的工具列(#137)與「顯示」設定搬家(#135)。
//
// 這支驗的是**版面擠不擠**與**東西在不在**,那是靜態掃描看不到的:
// 「四顆帶文字的按鈕在 390px 折成兩行」只有真的排版才知道。
//
// 每條都先斷言「東西找得到」再斷言行為 —— 選擇器腐爛時要紅,不是變成空掃的
// 綠燈(見 CLAUDE.md 裡 users_online.json 空 fixture 的教訓)。
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

async function openNotePane(page, width) {
  if (width < 768) {
    // 窄螢幕是分頁版:主分頁先切到「詳解」那一側,右欄的 strip 才出得來。
    const tab = page.locator('button', { hasText: '詳解' }).first();
    if (await tab.count()) await tab.click().catch(() => {});
    await page.waitForTimeout(250);
  }
  await page.locator('button', { hasText: '個人筆記' }).first().click();
  await page.waitForTimeout(400);
}

test('390px 的筆記工具列只有一行', async (t) => {
  if (guard(t)) return;
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 780 },
    isMobile: true,
    hasTouch: true,
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto(server.origin + '/q/113-050', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(700);
  await openNotePane(page, 390);

  const row = await page.evaluate(() => {
    const more = document.querySelector('[aria-label="更多筆記工具"]');
    if (!more) return null;
    const el = more.closest('div.flex');
    if (!el) return null;
    const kids = [...el.children].map((c) => Math.round(c.getBoundingClientRect().top));
    return { children: kids.length, rows: new Set(kids).size };
  });

  assert.ok(row, '找不到「更多」按鈕或它所在的那一列 —— 這條測試沒在驗東西');
  assert.ok(row.children >= 3, `工具列應該至少有 筆記切換 / 全螢幕 / 更多 三塊,實際 ${row.children}`);
  assert.equal(row.rows, 1, `390px 的工具列應該只有一行,實際 ${row.rows} 行`);
  assert.deepEqual(errors, []);

  await ctx.close();
});

test('「更多」裡剛好是自動挖空 / 防劇透 / 編輯,而且不溢出視窗', async (t) => {
  if (guard(t)) return;
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 780 },
    isMobile: true,
    hasTouch: true,
  });
  const page = await ctx.newPage();
  await page.goto(server.origin + '/q/113-050', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(700);
  await openNotePane(page, 390);

  await page.click('[aria-label="更多筆記工具"]');
  await page.waitForTimeout(250);

  const menu = await page.evaluate(() => {
    const m = [...document.querySelectorAll('[role="menu"]')].pop();
    if (!m) return null;
    const r = m.getBoundingClientRect();
    return {
      items: [...m.querySelectorAll('[role="menuitem"]')].map((e) => e.textContent.trim()),
      left: Math.round(r.left),
      right: Math.round(r.right),
      innerW: window.innerWidth,
    };
  });

  assert.ok(menu, '「更多」點下去沒有開出選單');
  assert.deepEqual(menu.items, ['自動挖空', '防劇透', '編輯']);
  assert.ok(menu.left >= 0, `選單左緣不該超出視窗:${menu.left}`);
  assert.ok(menu.right <= menu.innerW, `選單右緣溢出視窗:${menu.right} > ${menu.innerW}`);

  await ctx.close();
});

test('窄螢幕的筆記預覽字數砍半,寬螢幕維持原樣', async (t) => {
  if (guard(t)) return;
  // fixture 的第二則筆記標題剛好 40 個字 —— 兩種上限都會截斷,長度差得出來。
  const read = async (width, isMobile) => {
    const ctx = await browser.newContext({
      viewport: { width, height: 900 },
      ...(isMobile ? { isMobile: true, hasTouch: true } : {}),
    });
    const page = await ctx.newPage();
    await page.goto(server.origin + '/q/113-050', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(700);
    await openNotePane(page, width);
    await page.click('[title="切換這一題的筆記"]');
    await page.waitForTimeout(250);
    const titles = await page.evaluate(() => {
      const m = document.querySelector('[role="menu"]');
      return m
        ? [...m.querySelectorAll('[role="menuitem"] span span:first-child')].map((e) =>
            e.textContent.trim(),
          )
        : null;
    });
    await ctx.close();
    return titles;
  };

  const narrow = await read(390, true);
  const wide = await read(1280, false);

  assert.ok(narrow?.length >= 2, `窄螢幕讀不到筆記清單:${JSON.stringify(narrow)}`);
  assert.ok(wide?.length >= 2, `寬螢幕讀不到筆記清單:${JSON.stringify(wide)}`);
  // 長標題那一則:窄螢幕要明顯短一截。對照組是寬螢幕 —— 少了它,
  // 「窄螢幕比較短」可能只是因為兩邊都讀到了空字串。
  const longNarrow = narrow[1];
  const longWide = wide[1];
  assert.ok(longWide.length > longNarrow.length, `寬螢幕應該比較長:${longWide} vs ${longNarrow}`);
  assert.ok(longNarrow.length <= 21, `窄螢幕的預覽應該砍到一半(20 字 + 省略號):${longNarrow}`);
});

test('強制手機版面搬進 /profile,左下角不再有那顆 FAB', async (t) => {
  if (guard(t)) return;
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 780 },
    isMobile: true,
    hasTouch: true,
  });
  const page = await ctx.newPage();

  await page.goto(server.origin + '/q/113-050', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(700);
  const onQuestion = await page.evaluate(() => ({
    fab: !!document.querySelector('[aria-label="強制手機版面"], [aria-label="回到自動版面"]'),
    // 對照組:番茄鐘還在,證明這一頁的 FAB 本來就渲染得出來
    pomodoro: [...document.querySelectorAll('button')].some((b) =>
      (b.getAttribute('aria-label') || b.getAttribute('title') || '').includes('番茄鐘'),
    ),
  }));
  assert.equal(onQuestion.fab, false, '題目頁不該再有強制手機版面的 FAB');
  assert.ok(onQuestion.pomodoro, '番茄鐘也不見了 —— 這一頁根本沒渲染 FAB,上面那條斷言沒有意義');

  await page.goto(server.origin + '/profile', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(800);
  const onProfile = await page.evaluate(() => ({
    card: !!document.getElementById('profile-display'),
    sw: !!document.querySelector('[aria-label="強制手機版面"]'),
    coarse: window.matchMedia('(pointer: coarse)').matches,
  }));
  assert.ok(onProfile.coarse, '這個 context 不是觸控裝置,底下的斷言沒有意義');
  assert.ok(onProfile.card, '/profile 應該有「顯示」卡');
  assert.ok(onProfile.sw, '「顯示」卡裡應該有強制手機版面的開關');

  await ctx.close();
});

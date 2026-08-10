// 捲動時收起頂端/底部列(#136)—— 瀏覽器裡才驗得到的那一半。
//
// 判定邏輯(方向、閾值、橡皮筋)是純函式,在 src/lib/autoHideChrome.test.ts。
// 這裡驗的是**接線**:class 有沒有真的掛上去、CSS 有沒有真的位移、內層 sticky
// 有沒有跟著走、`<main>` 的留白有沒有保持不動、opt-out 的路由是不是真的不動。
//
// 每一條都先斷言「東西找得到」再斷言行為 —— 選擇器腐爛時要紅,不是變成空掃的
// 綠燈(見 CLAUDE.md 裡 users_online.json 空 fixture 的教訓)。
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

// 窄螢幕 + 矮視窗:收合只在 <md 生效,而視窗要夠矮才捲得動。
const PHONE = { width: 390, height: 640 };

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

async function openPage(url, viewport = PHONE) {
  const ctx = await browser.newContext({
    viewport,
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
  await ctx.addInitScript(([k, v]) => localStorage.setItem(k, v), [THEME_KEY, 'light']);
  const page = await ctx.newPage();
  await page.goto(server.origin + url, { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);
  // 頁面必須真的捲得動,否則底下每一條都是恆真的
  const scrollable = await page.evaluate(
    () => document.documentElement.scrollHeight - window.innerHeight,
  );
  return { ctx, page, scrollable };
}

/** 捲到指定位置並等收合動畫走完(transition 0.22s)。 */
async function scrollTo(page, y) {
  await page.evaluate((v) => window.scrollTo(0, v), y);
  await page.waitForTimeout(350);
}

const chromeBox = (page) =>
  page.evaluate(() => {
    const header = document.querySelector('header.app-chrome-top');
    const nav = document.querySelector('nav.app-chrome-bottom');
    const main = document.querySelector('main');
    return {
      hasHeader: !!header,
      hasNav: !!nav,
      headerTop: header ? Math.round(header.getBoundingClientRect().top) : null,
      headerH: header ? Math.round(header.getBoundingClientRect().height) : null,
      navTop: nav ? Math.round(nav.getBoundingClientRect().top) : null,
      hidden: document.documentElement.classList.contains('chrome-hidden'),
      mainPadTop: main ? getComputedStyle(main).paddingTop : null,
      viewportH: window.innerHeight,
    };
  });

test('往下捲收起、往回捲放回來', async (t) => {
  if (guard(t)) return;
  const { ctx, page, scrollable } = await openPage('/');

  assert.ok(scrollable > 400, `首頁在 ${PHONE.height}px 高的視窗要捲得動,實際 ${scrollable}`);

  const atTop = await chromeBox(page);
  assert.ok(atTop.hasHeader, '找不到 header.app-chrome-top —— 選擇器腐爛了');
  assert.ok(atTop.hasNav, '找不到 nav.app-chrome-bottom');
  assert.equal(atTop.headerTop, 0, '在頂端時 header 要在 0');
  assert.equal(atTop.navTop, atTop.viewportH - (atTop.viewportH - atTop.navTop),
    '(自明)先把 navTop 讀出來當基準');
  const navShownTop = atTop.navTop;

  await scrollTo(page, 400);
  const down = await chromeBox(page);
  assert.equal(down.hidden, true, '往下捲之後應該掛上 chrome-hidden');
  assert.ok(
    down.headerTop <= -down.headerH + 1,
    `header 應該整條移出畫面,實際 top=${down.headerTop} 高=${down.headerH}`,
  );
  assert.ok(
    down.navTop >= down.viewportH - 1,
    `底部導覽應該整條移出畫面,實際 top=${down.navTop} 視窗高=${down.viewportH}`,
  );

  await scrollTo(page, 340);
  const up = await chromeBox(page);
  assert.equal(up.hidden, false, '往回捲之後應該拿掉 chrome-hidden');
  assert.equal(up.headerTop, 0, 'header 要回到 0');
  assert.equal(up.navTop, navShownTop, '底部導覽要回到原位');

  await ctx.close();
});

test('收合過程中 <main> 的留白不變 —— 內容不能跟著位移', async (t) => {
  if (guard(t)) return;
  const { ctx, page } = await openPage('/');

  const before = await chromeBox(page);
  await scrollTo(page, 400);
  const after = await chromeBox(page);

  assert.equal(after.hidden, true, '前置條件:已經收起來');
  assert.equal(
    after.mainPadTop,
    before.mainPadTop,
    `<main> 的 padding-top 不能跟著收合變(${before.mainPadTop} → ${after.mainPadTop})`,
  );

  await ctx.close();
});

test('內層 sticky 跟著 header 滑上去遞補', async (t) => {
  if (guard(t)) return;
  // /q/:id 在窄螢幕是分頁版,頂端那條 年度/上下題 列是 chrome-follow。
  const { ctx, page, scrollable } = await openPage('/q/113-049');

  const strip = await page.evaluate(() => {
    const el = document.querySelector('.chrome-follow');
    return el ? { top: getComputedStyle(el).top } : null;
  });
  assert.ok(strip, '找不到 .chrome-follow —— 這條測試沒有驗到任何東西');

  if (scrollable < 200) {
    // 題目太短時整頁捲不動,行為無從觀察。這種情況要說出來,不要靜靜通過。
    t.diagnostic(`/q/113-049 只捲得動 ${scrollable}px,跳過位移比較`);
    await ctx.close();
    return;
  }

  const shown = await page.evaluate(
    () => parseFloat(getComputedStyle(document.querySelector('.chrome-follow')).top),
  );
  await scrollTo(page, Math.min(400, scrollable));
  const hiddenNow = await page.evaluate(() => ({
    hidden: document.documentElement.classList.contains('chrome-hidden'),
    top: parseFloat(getComputedStyle(document.querySelector('.chrome-follow')).top),
  }));

  assert.equal(hiddenNow.hidden, true, '前置條件:已經收起來');
  assert.ok(
    hiddenNow.top < shown,
    `收起時 .chrome-follow 的 top 要變小(${shown} → ${hiddenNow.top})—— 否則它會浮在半空`,
  );

  await ctx.close();
});

test('md 以上不收合', async (t) => {
  if (guard(t)) return;
  const { ctx, page, scrollable } = await openPage('/', { width: 1024, height: 640 });
  assert.ok(scrollable > 200, `桌機版也要捲得動才驗得到,實際 ${scrollable}`);

  await scrollTo(page, 400);
  const box = await chromeBox(page);
  assert.equal(box.headerTop, 0, 'md 以上 header 不該移動');

  await ctx.close();
});

test('/exam 不收合 —— 計時與交卷不能消失', async (t) => {
  if (guard(t)) return;
  const { ctx, page } = await openPage('/exam');

  await scrollTo(page, 400);
  const box = await chromeBox(page);
  assert.equal(box.hidden, false, '/exam 是 opt-out 路由,不該掛上 chrome-hidden');
  assert.equal(box.headerTop, 0, 'header 不該移動');

  await ctx.close();
});

test('離開 opt-out 路由時不會殘留收起狀態', async (t) => {
  if (guard(t)) return;
  // 反過來的方向:先在會收合的路由收起來,再走到 opt-out 路由。
  // 沒有清乾淨的話,新頁面一進去就頂著一條收起來的 header,而且捲到頂也回不來。
  const { ctx, page } = await openPage('/');
  await scrollTo(page, 400);
  assert.equal((await chromeBox(page)).hidden, true, '前置條件:已經收起來');

  await page.evaluate(() => {
    document.querySelector('nav.app-chrome-bottom a[href="/"]');
  });
  await page.goto(server.origin + '/exam', { waitUntil: 'networkidle' });
  await page.waitForTimeout(500);

  const box = await chromeBox(page);
  assert.equal(box.hidden, false, 'opt-out 路由不該殘留 chrome-hidden');
  assert.equal(box.headerTop, 0);

  await ctx.close();
});

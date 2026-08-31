// header 掉出來的下拉,不該被頁面內容蓋掉。
//
// 回報:「線上人數的 popover 並不是真的在最 z top,會被講義的筆記蓋掉。」
//
// 成因不是那個 popover 的 z-index 寫錯,而是**它根本改不動**:
// `.app-chrome` 帶 `will-change: transform`,那本身就建立一個 stacking context,
// 所以 header 裡面的 z-index 只是在 header 自己那一層裡排序。原本 header 是
// z-30、講義筆記面板(`<aside>`)也是 z-30 —— 同層由 DOM 順序決勝,而 `<main>`
// 在 `<header>` 後面,於是面板贏。
//
// **`NotificationBell` 的下拉早就寫著 z-50,而那一直是沒有作用的** —— 這支因此
// 兩個下拉都驗:一個是回報的那個,一個是「以為修好了其實沒有」的那個。
//
// ⚠️ 這條的判準必須是**打得到嗎**(`elementFromPoint`),不是 z-index 的數字:
// 數字大小跟誰畫在上面之間隔著 stacking context,而這個 bug 的全部內容就是那一層。
// 而且要先斷言 popover 真的跟面板**在水平方向重疊**,否則取樣點全落在面板左邊,
// 這支測試會變成恆真的綠燈(第一版的探針就是這樣,量到「沒問題」)。
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

const SLUG = 'lecture-e2e';
const PDF = fs.readFileSync(path.join(HERE, 'fixtures', `${SLUG}.pdf`));
const DOC = {
  slug: SLUG,
  title: 'e2e 講義',
  kind: 'lecture',
  pages: 3,
  r2_key: `lectures/${SLUG}.pdf`,
  pdf_url: `/lectures-pdf/${SLUG}.pdf`,
  notes: [],
  annotations: [],
};

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

/** 開講義閱讀器 —— 右欄的筆記面板就是那個蓋住 popover 的東西。 */
async function openReader() {
  // lg 以上,線上人數才展開成頭像列;而面板也才是桌機的 in-flow 右欄。
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    serviceWorkers: 'block',
  });
  await ctx.route('**/*', (r) =>
    r.request().url().startsWith(server.origin) ? r.continue() : r.abort(),
  );
  await ctx.route(`**/api/lectures/${SLUG}`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify(DOC),
    }),
  );
  await ctx.route(`**/lectures-pdf/${SLUG}.pdf`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/pdf', body: PDF }),
  );
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${server.origin}/lectures/${SLUG}`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForSelector('aside.z-30', { timeout: 25_000 });
  return { ctx, page, errors };
}

/**
 * 點開 header 上的某個下拉,回報「它跟筆記面板重疊的那一段,打不打得到」。
 * 取樣點刻意集中在重疊帶 —— popover 左半邊本來就沒有東西蓋得到。
 */
async function probe(page, label) {
  return page.evaluate((lbl) => {
    const btns = [...document.querySelectorAll('header button')].filter((b) =>
      (
        (b.getAttribute('aria-label') ?? '') + (b.getAttribute('title') ?? '')
      ).includes(lbl),
    );
    // md–lg 的計數徽章與 lg 的頭像列是兩顆,只有一顆真的在畫面上。
    const btn = btns.find((b) => b.getClientRects().length > 0);
    if (!btn) return { error: `找不到「${lbl}」的觸發鈕` };
    const host = btn.closest('div.relative') ?? btn.parentElement;
    const pop = [...host.children].find(
      (el) =>
        el !== btn &&
        el.tagName === 'DIV' &&
        getComputedStyle(el).position === 'absolute',
    );
    if (!pop) return { error: `「${lbl}」點開之後沒有下拉` };

    const aside = document.querySelector('aside.z-30');
    if (!aside) return { error: '找不到講義筆記面板' };
    const a = aside.getBoundingClientRect();
    const p = pop.getBoundingClientRect();

    const from = Math.max(p.left, a.left) + 4;
    const to = p.right - 4;
    const overlap = to - from;

    const misses = [];
    if (overlap > 0) {
      for (const fy of [0.08, 0.3, 0.6, 0.92]) {
        for (const fx of [0, 0.5, 1]) {
          const x = from + (to - from) * fx;
          const y = p.top + p.height * fy;
          const el = document.elementFromPoint(x, y);
          if (!pop.contains(el))
            misses.push({
              x: Math.round(x),
              y: Math.round(y),
              tag: el?.tagName ?? 'null',
              cls: String(el?.className ?? '').slice(0, 48),
            });
        }
      }
    }
    return { overlap: Math.round(overlap), misses };
  }, label);
}

async function assertOnTop(page, label) {
  const r = await probe(page, label);
  assert.equal(r.error, undefined, r.error);
  // 對照組:沒有重疊的話,底下那個「0 個被蓋住」什麼都沒證明。
  assert.ok(
    r.overlap > 20,
    `「${label}」的下拉跟筆記面板只重疊 ${r.overlap}px —— 這條測不到東西`,
  );
  assert.deepEqual(
    r.misses,
    [],
    `「${label}」的下拉有 ${r.misses.length} 個取樣點被別的東西蓋住`,
  );
}

test('線上人數的下拉不會被講義筆記面板蓋掉', async (t) => {
  if (skipReason) {
    if (REQUIRE) assert.fail(`E2E_REQUIRE=1 但無法執行:${skipReason}`);
    return t.skip(skipReason);
  }

  const { ctx, page, errors } = await openReader();
  try {
    await page.locator('header button[title$="人在線"]:visible').first().click();
    await page.waitForTimeout(200);
    await assertOnTop(page, '人在線');
    assert.deepEqual(errors, []);
  } finally {
    await ctx.close();
  }
});

test('通知的下拉同理 —— 它寫著 z-50,而那一直是沒有作用的', async (t) => {
  if (skipReason) {
    if (REQUIRE) assert.fail(`E2E_REQUIRE=1 但無法執行:${skipReason}`);
    return t.skip(skipReason);
  }

  const { ctx, page, errors } = await openReader();
  try {
    await page.locator('header button[aria-label="通知"]').first().click();
    await page.waitForTimeout(300);
    await assertOnTop(page, '通知');
    assert.deepEqual(errors, []);
  } finally {
    await ctx.close();
  }
});

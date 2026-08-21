// 講義閱讀器的 `?page=` 深連結與網址同步。
//
// 純函式在 `src/lib/lecturePageParam.test.ts`(1-based ↔ 0-indexed、沒變就不寫、
// 其他參數保留)。這裡驗的是**接線**:進站時有沒有真的跳到那一頁、換頁之後網址
// 有沒有跟上、以及**有沒有把歷史紀錄灌爆**。
//
// ⚠️ 這是第一支碰得到 PDF 閱讀器的測試。它需要一份真的 PDF —— `fixtures/
// lecture-e2e.pdf` 是 6 頁的最小合法檔(每頁只有 "PAGE N"),用 pdfium wasm 開得起來。
// 沒有它的話整個 viewer 不會就緒,`?page=` 的跳頁也就無從觸發。
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
let pdf;
let skipReason = null;

const SLUG = 'lecture-e2e';
const DOC = {
  slug: SLUG,
  title: 'E2E 測試講義',
  sort_order: 1,
  r2_key: `lectures/${SLUG}.pdf`,
  page_count: 6,
  bytes: 1891,
  created_at: 1754000000000,
  anno_count: 0,
  note_count: 0,
  kind: 'lecture',
  pdf_url: `/lectures-pdf/${SLUG}.pdf`,
};

before(async () => {
  if (!fs.existsSync(path.join(DIST, 'index.html'))) {
    skipReason = `找不到 ${DIST}/index.html —— 先跑 pnpm --dir frontend build`;
    return;
  }
  const pdfPath = path.join(HERE, 'fixtures', 'lecture-e2e.pdf');
  if (!fs.existsSync(pdfPath)) {
    // `.gitignore` 有一條 `*.pdf`(擋講義本體),這份合成檔靠一條 `!` 例外進版控。
    // 那條例外要是被順手清掉,這裡的訊息比一個 ENOENT stack 好懂得多。
    skipReason = `找不到 ${pdfPath} —— 檢查 .gitignore 的 !frontend/e2e/fixtures/*.pdf`;
    return;
  }
  pdf = fs.readFileSync(pdfPath);
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

async function openReader(query = '') {
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    serviceWorkers: 'block',
  });
  // 數 replaceState / pushState —— 「每翻一頁塞一筆歷史」是這個功能最容易犯的錯,
  // 而它在畫面上完全看不出來,只有按上一頁時才會發現離不開這一頁。
  await ctx.addInitScript(() => {
    window.__hist = { replace: 0, push: 0 };
    const r = history.replaceState.bind(history);
    const p = history.pushState.bind(history);
    history.replaceState = (...a) => {
      window.__hist.replace += 1;
      return r(...a);
    };
    history.pushState = (...a) => {
      window.__hist.push += 1;
      return p(...a);
    };
  });
  await ctx.route(`**/api/lectures/${SLUG}`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify(DOC),
    }),
  );
  await ctx.route(`**/lectures-pdf/${SLUG}.pdf`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/pdf', body: pdf }),
  );
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${server.origin}/lectures/${SLUG}${query}`, {
    waitUntil: 'domcontentloaded',
  });
  return { ctx, page, errors };
}

// 工具列的頁碼是一顆按鈕(寫著 `p.4 / 6`,點下去才變成輸入框),所以認的是文字
// 而不是 input —— 閱讀器對「現在第幾頁」的唯一可見宣告。
const PAGE_BTN = 'button[title="點擊輸入頁碼跳頁"]';

const shownPage = (page) =>
  page.evaluate((sel) => {
    const m = /p\.(\d+)/.exec(document.querySelector(sel)?.textContent ?? '');
    return m ? Number(m[1]) : null;
  }, PAGE_BTN);

const waitReady = (page) =>
  page.waitForFunction((sel) => !!document.querySelector(sel), PAGE_BTN, {
    timeout: 25_000,
  });

const waitShown = (page, n) =>
  page.waitForFunction(
    ({ sel, n }) => {
      const m = /p\.(\d+)/.exec(document.querySelector(sel)?.textContent ?? '');
      return !!m && Number(m[1]) === n;
    },
    { sel: PAGE_BTN, n },
    { timeout: 25_000 },
  );

test('?page=N 進站直接落在那一頁', async (t) => {
  if (guard(t)) return;
  const { ctx, page, errors } = await openReader('?page=4');
  try {
    await waitReady(page);
    await waitShown(page, 4);
    assert.equal(await shownPage(page), 4);
    assert.deepEqual(errors, [], '有未攔截的例外');
  } finally {
    await ctx.close();
  }
});

test('換頁之後網址跟著走 —— 複製出去才會落在同一頁', async (t) => {
  if (guard(t)) return;
  const { ctx, page, errors } = await openReader('?page=2');
  try {
    await waitReady(page);
    await waitShown(page, 2);

    await page.locator('[aria-label="下一頁 (D / →)"]').click();
    await page.waitForFunction(
      () => new URLSearchParams(location.search).get('page') === '3',
      null,
      { timeout: 25_000 },
    );
    assert.equal(new URL(page.url()).searchParams.get('page'), '3');

    // 回到第一頁時參數要消失,不是留下 ?page=1
    await page.locator('[aria-label="上一頁 (U / ←)"]').click();
    await page.locator('[aria-label="上一頁 (U / ←)"]').click();
    await page.waitForFunction(
      () => new URLSearchParams(location.search).get('page') === null,
      null,
      { timeout: 25_000 },
    );
    assert.equal(new URL(page.url()).searchParams.get('page'), null);
    assert.deepEqual(errors, [], '有未攔截的例外');
  } finally {
    await ctx.close();
  }
});

test('翻頁用 replace,不塞歷史紀錄 —— 否則按上一頁離不開這份講義', async (t) => {
  if (guard(t)) return;
  const { ctx, page, errors } = await openReader();
  try {
    await waitReady(page);
    const before = await page.evaluate(() => history.length);

    // ⚠️ 不要寫死「按 N 次就會到第 N+1 頁」。剛載入時 viewer 還在排版,第一次
    // 點擊會被吞掉(既有行為,與網址同步無關)。這裡驗的是**網址與閱讀器一致**,
    // 不是點擊次數 —— 綁死次數只會做出一支會隨機紅的測試。
    for (let i = 0; i < 4; i++) {
      await page.locator('[aria-label="下一頁 (D / →)"]').click();
      await page.waitForTimeout(800); // 大於同步的 debounce
    }
    const shown = await shownPage(page);
    assert.ok(shown > 1, `翻了 4 次還停在第 ${shown} 頁`);
    await page.waitForFunction(
      ({ n }) => new URLSearchParams(location.search).get('page') === String(n),
      { n: shown },
      { timeout: 25_000 },
    );

    const hist = await page.evaluate(() => ({ ...window.__hist, len: history.length }));
    assert.equal(hist.len, before, `翻頁之後歷史長度從 ${before} 變成 ${hist.len}`);
    assert.equal(hist.push, 0, `不該有 pushState,實際 ${hist.push} 次`);
    // debounce 有在做事:每次換頁最多寫一次,不是每一幀都寫。
    assert.ok(
      hist.replace <= shown + 2,
      `翻到第 ${shown} 頁卻呼叫了 ${hist.replace} 次 replaceState,debounce 沒有生效?`,
    );
    assert.deepEqual(errors, [], '有未攔截的例外');
  } finally {
    await ctx.close();
  }
});

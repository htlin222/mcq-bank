// 講義書籤(migration 0042)的接線:閱讀器左側 rail 的第二個分頁、工具列那顆
// toggle,以及 /lectures?tab=bookmark 的卡片格線。
//
// 排序與過濾的邊界在純函式測試裡(`src/lib/bookmarkSort.test.ts`)—— 這裡驗的
// 是「接上去了沒」:分頁切得動嗎、清單真的重排了嗎、那顆鈕送出去的頁碼對嗎。
//
// ⚠️ 每一條都先斷言「東西找得到」再斷言行為。少了前半段,選擇器一腐爛就退化
// 成空掃的綠燈 —— 這個 repo 已經被 `users_online.json` 空 fixture 騙過一次。
//
// ⚠️ 頁碼在兩個座標系之間換算:viewer 是 0-based,書籤存 1-based。這支測試
// 的價值有一半在那個 ±1 上,所以斷言的是**具體頁碼**,不是「有送出請求」。
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

// 閱讀器裡先擺一則書籤(第 3 頁,1-based),用來驗 rail 的清單與跳頁。
const READER_BOOKMARKS = [
  {
    id: 'bm-r1',
    slug: SLUG,
    page: 3,
    created_at: 1754500000000,
    title: DOC.title,
    instructor: '',
    sort_order: 1,
    note_preview: '這一頁的講義筆記預覽',
  },
];

before(async () => {
  if (!fs.existsSync(path.join(DIST, 'index.html'))) {
    skipReason = `找不到 ${DIST}/index.html —— 先跑 pnpm --dir frontend build`;
    return;
  }
  const pdfPath = path.join(HERE, 'fixtures', 'lecture-e2e.pdf');
  if (!fs.existsSync(pdfPath)) {
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

const PAGE_BTN = 'button[title="點擊輸入頁碼跳頁"]';
const RAIL_TAB = '[role="tablist"][aria-label="側邊欄"] [role="tab"]';

const shownPage = (page) =>
  page.evaluate((sel) => {
    const m = /p\.(\d+)/.exec(document.querySelector(sel)?.textContent ?? '');
    return m ? Number(m[1]) : null;
  }, PAGE_BTN);

/** 開閱讀器,並把書籤的三支端點都攔下來記錄。 */
async function openReader() {
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    serviceWorkers: 'block',
  });
  const writes = [];
  let list = [...READER_BOOKMARKS];

  await ctx.route(`**/api/lectures/${SLUG}/bookmarks`, (route) => {
    const req = route.request();
    if (req.method() === 'POST') {
      const body = JSON.parse(req.postData() || '{}');
      writes.push({ method: 'POST', page: body.page });
      const row = { ...READER_BOOKMARKS[0], id: `bm-new-${body.page}`, page: body.page };
      list = [...list, row];
      return route.fulfill({
        status: 200,
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify(row),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify(list),
    });
  });
  await ctx.route(`**/api/lectures/${SLUG}/bookmarks/*`, (route) => {
    const url = new URL(route.request().url());
    writes.push({
      method: route.request().method(),
      page: Number(url.pathname.split('/').pop()),
    });
    return route.fulfill({
      status: 200,
      contentType: 'application/json; charset=utf-8',
      body: '{"ok":true}',
    });
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
  await page.goto(`${server.origin}/lectures/${SLUG}`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForSelector(PAGE_BTN, { timeout: 25_000 });
  return { ctx, page, errors, writes: () => writes };
}

test('rail 的書籤分頁:列得出來、點得動、跳得到那一頁', async (t) => {
  if (guard(t)) return;
  const { ctx, page, errors } = await openReader();
  try {
    // rail 掛在 viewer 的 provider 樹裡,比工具列晚一步就緒 —— 直接 $$eval 會
    // 量到 0 個元素,然後把「還沒好」誤報成「名字不對」。
    await page.waitForSelector(RAIL_TAB, { timeout: 20_000 });

    // 空掃防線:分頁列要有兩顆,而且名字對得上。
    const tabs = await page.$$eval(RAIL_TAB, (els) =>
      els.map((e) => e.textContent.trim()),
    );
    assert.deepEqual(tabs, ['縮圖', '書籤'], `rail 分頁列不對:${JSON.stringify(tabs)}`);

    await page.click(`${RAIL_TAB} >> nth=1`);
    await page.waitForTimeout(200);

    // 書籤那一列要看得到頁碼與筆記預覽。
    const item = await page.$('aside button[aria-label]');
    assert.ok(item, '切到書籤分頁後找不到任何一則書籤');
    const railText = await page.$eval('aside', (el) => el.textContent);
    assert.match(railText, /p\.3/, `rail 沒列出第 3 頁的書籤:${railText.slice(0, 120)}`);
    assert.match(railText, /這一頁的講義筆記預覽/, '沒有顯示該頁筆記的預覽');

    // 點下去要真的跳頁。書籤存 1-based,viewer 是 0-based —— 這一行就是那個
    // 換算的守門人。
    const before = await shownPage(page);
    await page.click('aside ul li button >> nth=0');
    await page.waitForFunction(
      (sel) => /p\.3\b/.test(document.querySelector(sel)?.textContent ?? ''),
      PAGE_BTN,
      { timeout: 10_000 },
    );
    assert.notEqual(before, 3, '起始頁就已經是 3,這條斷言證明不了跳頁');
    assert.equal(await shownPage(page), 3);
    assert.deepEqual(errors, []);
  } finally {
    await ctx.close();
  }
});

test('工具列那顆是 toggle,而且送出的是 1-based 頁碼', async (t) => {
  if (guard(t)) return;
  const { ctx, page, errors, writes } = await openReader();
  try {
    // 第 1 頁沒有書籤 → 鈕寫著「加入書籤」。
    const addBtn = await page.$('button[aria-label="加入書籤 (B)"]');
    assert.ok(addBtn, '第 1 頁上找不到「加入書籤」的按鈕');
    await addBtn.click();

    // 加完之後同一顆要變成「移除書籤」—— 一顆永遠寫著「加入」的鈕,在已加過的
    // 頁面上按下去看起來就是沒反應。
    await page.waitForSelector('button[aria-label="移除書籤 (B)"]', { timeout: 10_000 });

    await page.click('button[aria-label="移除書籤 (B)"]');
    await page.waitForSelector('button[aria-label="加入書籤 (B)"]', { timeout: 10_000 });

    assert.deepEqual(
      writes(),
      [
        { method: 'POST', page: 1 },
        { method: 'DELETE', page: 1 },
      ],
      'viewer 的 0-based currentPage 沒有換算成 1-based 就送出去了',
    );
    assert.deepEqual(errors, []);
  } finally {
    await ctx.close();
  }
});

test('/lectures?tab=bookmark:卡片格線、排序切換與過濾', async (t) => {
  if (guard(t)) return;
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    serviceWorkers: 'block',
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await ctx.route('**/*', (r) =>
    r.request().url().startsWith(server.origin) ? r.continue() : r.abort(),
  );
  try {
    await page.goto(`${server.origin}/lectures?tab=bookmark`, {
      waitUntil: 'domcontentloaded',
    });
    await page.waitForSelector('a[href*="?page="]', { timeout: 15_000 });

    const cards = () =>
      page.$$eval('a[href*="?page="]', (els) => els.map((e) => e.getAttribute('href')));

    // 預設「依日期」(新→舊):bm-3(p.33) > bm-1(p.17) > bm-2(p.5)
    const byDate = await cards();
    assert.equal(byDate.length, 3, `卡片數不對:${JSON.stringify(byDate)}`);
    assert.deepEqual(byDate, [
      '/lectures/heme-review-01?page=33',
      '/lectures/heme-review-02?page=17',
      '/lectures/heme-review-01?page=5',
    ]);

    // 「依文件」:sort_order 1 的兩則在前,而且同一份講義內依頁碼。
    await page.click('button:has-text("依文件")');
    await page.waitForTimeout(200);
    assert.deepEqual(await cards(), [
      '/lectures/heme-review-01?page=5',
      '/lectures/heme-review-01?page=33',
      '/lectures/heme-review-02?page=17',
    ]);

    // 過濾吃標題與筆記預覽兩邊。
    await page.fill('input[type="search"]', '缺鐵');
    await page.waitForTimeout(200);
    assert.deepEqual(await cards(), ['/lectures/heme-review-01?page=33']);

    assert.deepEqual(errors, []);
  } finally {
    await ctx.close();
  }
});

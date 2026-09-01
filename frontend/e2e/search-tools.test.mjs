// 搜尋頁上的三件事:多關鍵字(逗號 = OR)、AI 進階搜尋、把結果出成一份測驗。
//
// 查詢語法本身有純函式測試(`worker/lib/fts-query.test.ts`、
// `frontend/src/lib/markTerms.test.ts`);這支驗的是**接線** —— 送出去的網址對不對、
// 對話框選完之後真的把字填回搜尋框並重查、出卷連結帶的是不是這一批題號。
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

const HITS = JSON.parse(
  fs.readFileSync(path.join(HERE, 'fixtures', 'search.json'), 'utf8'),
).items;
const EXPAND = JSON.parse(
  fs.readFileSync(path.join(HERE, 'fixtures', 'search_expand.json'), 'utf8'),
);

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
  if (REQUIRE) assert.fail(`E2E_REQUIRE=1 但無法執行:${skipReason}`);
  t.skip(skipReason);
  return true;
}

async function open(t, url = '/search') {
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    serviceWorkers: 'block',
  });
  const searches = [];
  await ctx.route('**/api/search**', async (route) => {
    const u = new URL(route.request().url());
    // `/api/search/expand` 與 `/api/search` 都會落到這條 —— 用 pathname 分,
    // 不要用兩條 glob 去分(太容易寫成互相覆蓋,而那會讓計數靜靜失真)。
    if (u.pathname.endsWith('/expand')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify(EXPAND),
      });
    }
    if (u.pathname.endsWith('/history')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify({ items: [] }),
      });
    }
    searches.push(u.searchParams.get('q') ?? '');
    return route.fulfill({
      status: 200,
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify({ items: HITS, q: u.searchParams.get('q') }),
    });
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(server.origin + url, { waitUntil: 'domcontentloaded' });
  t.after(async () => {
    await ctx.close();
  });
  return { ctx, page, errors, searches };
}

test('多關鍵字:逗號原樣送到伺服器(OR 的轉換在那一側)', async (t) => {
  if (guard(t)) return;
  const { ctx, page, errors, searches } = await open(t);
  try {
    await page.locator('input[placeholder^="關鍵字"]').fill('AML, CML');
    await page.getByRole('button', { name: '搜尋', exact: true }).click();
    await page.locator('ul li').first().waitFor({ timeout: 20_000 });

    // 逗號不在前端展開 —— 展開的地方只有一個(worker/lib/fts-query.ts),
    // 兩邊各做一次遲早會不一致。
    assert.deepEqual(searches, ['AML, CML']);
    assert.deepEqual(errors, []);
  } finally {
    await ctx.close();
  }
});

test('命中的字在**整段題幹**裡標起來 —— 不是 FTS 片段', async (t) => {
  if (guard(t)) return;
  const { ctx, page, errors } = await open(t, '/search?q=' + encodeURIComponent('白血病, 骨髓'));
  try {
    const row = page.locator('ul li').first();
    await row.waitFor({ timeout: 20_000 });

    const marks = await row.locator('mark').allInnerTexts();
    // 對照組:真的標到東西了,否則下面「標的是這幾個字」恆真。
    assert.ok(marks.length > 0, '題幹裡一個標記都沒有');
    // 標的必須是使用者打的字,大小寫/全形逗號都要吃得下來。
    assert.ok(
      marks.every((m) => m === '白血病' || m === '骨髓'),
      `標到了不該標的東西:${JSON.stringify(marks)}`,
    );
    // 而且整段題幹都在(不是 snippet 的「…」片段)。
    const stem = HITS[0].stem;
    assert.ok(
      (await row.innerText()).includes(stem.slice(-12)),
      '題幹尾端不見了 —— 還在用 FTS 片段',
    );
    assert.deepEqual(errors, []);
  } finally {
    await ctx.close();
  }
});

test('AI 進階搜尋:在搜尋鈕左邊,沒有關鍵字時停用', async (t) => {
  if (guard(t)) return;
  const { ctx, page, errors } = await open(t);
  try {
    const ai = page.getByRole('button', { name: 'AI 進階搜尋' });
    const submit = page.getByRole('button', { name: '搜尋', exact: true });
    await ai.waitFor({ timeout: 20_000 });

    // 「在搜尋按鈕左邊」是使用者原話 —— 用實際座標驗,不是靠 DOM 順序猜。
    const a = await ai.boundingBox();
    const b = await submit.boundingBox();
    assert.ok(a.x + a.width <= b.x + 1, `AI 鈕不在搜尋鈕左邊:${a.x} vs ${b.x}`);

    // 一顆按了不會有任何變化的按鈕比沒有這顆更糟。
    assert.equal(await ai.isDisabled(), true, '沒有關鍵字時不該可以按');
    await page.locator('input[placeholder^="關鍵字"]').fill('AML');
    assert.equal(await ai.isDisabled(), false, '打了字之後應該可以按');
    assert.deepEqual(errors, []);
  } finally {
    await ctx.close();
  }
});

test('AI 進階搜尋:選好的詞會變成逗號字串填回搜尋框,並直接重查', async (t) => {
  if (guard(t)) return;
  const { ctx, page, errors, searches } = await open(t);
  try {
    const input = page.locator('input[placeholder^="關鍵字"]');
    await input.fill('AML');
    await page.getByRole('button', { name: 'AI 進階搜尋' }).click();

    const dialog = page.locator('[role="dialog"]');
    await dialog.waitFor({ timeout: 10_000 });
    // 對照組:詞真的出來了。
    for (const t2 of EXPAND.terms) {
      await dialog.getByRole('button', { name: t2, exact: true }).waitFor({ timeout: 10_000 });
    }

    // 取消掉一個 —— 模型偶爾會給出離題的同義詞,而一個離題的 OR 分支會把不相干
    // 的題目拉進結果。
    const dropped = EXPAND.terms[2];
    await dialog.getByRole('button', { name: dropped, exact: true }).click();

    // 原查詢那一顆不給取消:全部取消掉之後套用會得到一個空的搜尋框。
    assert.equal(
      await dialog.getByRole('button', { name: EXPAND.terms[0], exact: true }).isDisabled(),
      true,
      '原查詢那一顆不該可以取消',
    );

    await dialog.getByRole('button', { name: '套用並搜尋', exact: true }).click();
    await dialog.waitFor({ state: 'detached', timeout: 5_000 });

    const expected = EXPAND.terms.filter((x) => x !== dropped).join(', ');
    assert.equal(await input.inputValue(), expected, '搜尋框沒有換成選好的那幾個詞');
    // 直接重查,不要讓使用者再按一次 —— 他按那顆按鈕的意圖就是「用這些字去找」。
    assert.deepEqual(searches, [expected], `送出的查詢不對:${JSON.stringify(searches)}`);
    assert.deepEqual(errors, []);
  } finally {
    await ctx.close();
  }
});

test('把結果出成一份測驗:連結帶的是這一批題號', async (t) => {
  if (guard(t)) return;
  const { ctx, page, errors } = await open(t, '/search?q=' + encodeURIComponent('白血病'));
  try {
    const link = page.getByRole('link', { name: `把這 ${HITS.length} 題出成測驗 →` });
    await link.waitFor({ timeout: 20_000 });

    // ⚠️ 帶的是**題號清單**,不是篩選條件:這一頁的條件是全文檢索,沒有辦法用
    // status/year/group/tag 表達出來(錯題回顧可以,所以它帶的是 query string)。
    const href = await link.getAttribute('href');
    assert.match(href, /^\/exam\/new\?ids=/);
    assert.deepEqual(
      new URLSearchParams(href.split('?')[1]).get('ids').split(','),
      HITS.map((h) => h.id),
    );

    await link.click();
    // 出卷頁要講清楚它只從這批題目裡出 —— 否則畫面上的條件看起來像全題庫,
    // 而算出來的題數卻只有幾題,那個落差沒有任何地方解釋得了。
    await page
      .getByText(`只從 搜尋結果的 ${HITS.length} 題 裡出卷`, { exact: false })
      .waitFor({ timeout: 20_000 });
    assert.deepEqual(errors, []);
  } finally {
    await ctx.close();
  }
});

// 從全真成績頁點進某一題之後,要走得回成績頁。
//
// 在這之前,`/q/:id` 的 header 只有「民國 xx 年」—— 檢討成績時點進一題,回頭
// 的路是瀏覽器上一頁,而使用者按了上一題/下一題之後那條路已經被自己的導覽塞滿。
// 作法沿用 `fromSearch`:成績頁在 history state 裡塞 `fromExam: sid`,題目頁
// 看到就多畫一條「全真結果」。
//
// 三個刻意的地方:
//
//   1. **對照組**:直接深連結到同一題(沒有 state)時那條連結不該出現。少了它,
//      一個「永遠都畫出來」的實作也會全綠 —— 而那條連結在沒有 sid 的情況下會
//      指向 `/exam/undefined/result`。
//   2. **按過下一題之後還要在**。state 是靠 `navigate(..., { state })` 一路
//      傳下去的,漏掉那個參數的症狀是「點第一題可以回去,翻一題之後就不行」。
//   3. 題目 payload 與同年度清單都由 `ctx.route` 注入 —— fixture 只有 113-050
//      有真的題目,而成績頁 fixture 的題號是 113-001~003。
//
// 同一段旅程的另一半:**走回去要落在原本的畫面上**(捲動位置 + 篩選)。
// 只還原 y 是不夠的 —— 清單長度隨篩選變,落在一份比較短的清單上的同一個 y
// 看起來只是「隨便跳」。純函式(壞掉的 JSON、認不得的 filter、NaN 的 y)在
// `frontend/src/lib/examResultView.test.ts`,這裡驗的是接線。
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

const SID = 'e2e-1';
const RESULT_PATH = `/exam/${SID}/result`;
const BASE = JSON.parse(
  fs.readFileSync(path.join(HERE, 'fixtures', 'questions_113-050.json'), 'utf8'),
);
const EXAM = JSON.parse(
  fs.readFileSync(path.join(HERE, 'fixtures', `exam_${SID}.json`), 'utf8'),
);
// 成績頁預設篩選是「答錯/未答」,前兩題都落在那裡。
const [Q1, Q2] = EXAM.answers;

/** 借 113-050 的形狀,換上成績頁真的有的題號。 */
function payload(id, number) {
  return {
    ...BASE,
    id,
    number,
    stem: `這是第 ${number} 題的題幹`,
    explanation: null,
    my_note: null,
    my_notes: [],
  };
}

const YEAR_LIST = EXAM.answers.map((a) => ({
  id: a.question_id,
  number: a.number,
}));

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

async function newPage({ height = 900 } = {}) {
  const ctx = await browser.newContext({
    viewport: { width: 1280, height },
    serviceWorkers: 'block',
  });
  // ⚠️ 順序:Playwright **後註冊的先比對**,所以擋外連的 catch-all 要先掛。
  await ctx.route('**/*', (r) =>
    r.request().url().startsWith(server.origin) ? r.continue() : r.abort(),
  );
  const json = (route, body) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify(body),
    });
  // 同年度清單:上一題/下一題就是靠它算出來的,沒有它按鈕根本不會出現。
  await ctx.route('**/api/questions?year=*', (route) => json(route, YEAR_LIST));
  // 題目底下那幾支附屬端點沒有 fixture,伺服器會回 `{}` —— 而它們的消費端是
  // `.map()`,於是整頁在 render 期間就炸掉、什麼都畫不出來。**後註冊的先比對**,
  // 所以形狀特別的那兩支要排在通則後面。
  await ctx.route('**/api/questions/113-0*/*', (route) => json(route, []));
  await ctx.route('**/api/questions/113-0*/videos', (route) =>
    json(route, { topics: [], total: 0 }),
  );
  await ctx.route('**/api/questions/113-0*/note/links', (route) =>
    json(route, { links: [] }),
  );
  for (const a of EXAM.answers) {
    await ctx.route(`**/api/questions/${a.question_id}`, (route) =>
      json(route, payload(a.question_id, a.number)),
    );
  }
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  return { ctx, page, errors };
}

const backLink = (page) =>
  page.locator('a[href*="/result"]', { hasText: '全真結果' });

test('成績頁點進題目 → 題目頁有「全真結果」,而且翻頁之後還在', async (t) => {
  if (skipReason) {
    if (REQUIRE) assert.fail(`E2E_REQUIRE=1 但無法執行:${skipReason}`);
    return t.skip(skipReason);
  }

  const { ctx, page, errors } = await newPage();
  try {
    await page.goto(`${server.origin}${RESULT_PATH}`, {
      waitUntil: 'domcontentloaded',
    });

    // 空掃防線:先確認那一列真的找得到,再點它。
    const row = page.locator(`a[href="/q/${Q1.question_id}"]`).first();
    await row.waitFor({ timeout: 20_000 });
    await row.click();

    await page.waitForFunction(
      (id) => location.pathname === `/q/${id}`,
      Q1.question_id,
      { timeout: 10_000 },
    );
    await page.waitForSelector(`text=這是第 ${Q1.number} 題的題幹`, {
      timeout: 20_000,
    });

    const back = backLink(page);
    await back.first().waitFor({ timeout: 10_000 });
    assert.equal(
      await back.first().getAttribute('href'),
      RESULT_PATH,
      '「全真結果」指到的不是這一場的成績頁',
    );

    // 翻一題:state 要跟著 navigate 一起傳下去。
    await page.locator('button', { hasText: '下一題' }).first().click();
    await page.waitForFunction(
      (id) => location.pathname === `/q/${id}`,
      Q2.question_id,
      { timeout: 10_000 },
    );
    await page.waitForSelector(`text=這是第 ${Q2.number} 題的題幹`, {
      timeout: 20_000,
    });
    assert.equal(
      await backLink(page).count(),
      1,
      '按過下一題之後「全真結果」不見了 —— navigate 沒有把 state 傳下去',
    );

    // 真的走得回去。
    await backLink(page).first().click();
    await page.waitForFunction(
      (p) => location.pathname === p,
      RESULT_PATH,
      { timeout: 10_000 },
    );
    await page.waitForSelector('button:has-text("展開選項")', {
      timeout: 20_000,
    });

    assert.deepEqual(errors, []);
  } finally {
    await ctx.close();
  }
});

test('直接深連結到題目時沒有「全真結果」', async (t) => {
  if (skipReason) {
    if (REQUIRE) assert.fail(`E2E_REQUIRE=1 但無法執行:${skipReason}`);
    return t.skip(skipReason);
  }

  const { ctx, page, errors } = await newPage();
  try {
    await page.goto(`${server.origin}/q/${Q1.question_id}`, {
      waitUntil: 'domcontentloaded',
    });
    // 正面斷言先行:題目真的畫出來了,底下那個 0 才有話語權。
    await page.waitForSelector(`text=這是第 ${Q1.number} 題的題幹`, {
      timeout: 20_000,
    });
    assert.equal(
      await backLink(page).count(),
      0,
      '沒有來源的深連結不該有「全真結果」—— 那條連結會指向 /exam/undefined/result',
    );
    assert.deepEqual(errors, []);
  } finally {
    await ctx.close();
  }
});

test('走回成績頁時落在原本的捲動位置', async (t) => {
  if (skipReason) {
    if (REQUIRE) assert.fail(`E2E_REQUIRE=1 但無法執行:${skipReason}`);
    return t.skip(skipReason);
  }

  // 矮視窗:預設的 900 高度下這份 fixture(兩張卡)根本捲不動,底下每一條
  // 斷言都會恆真 —— 同「量折行用倍率不用固定餘裕」那類的假綠。
  const { ctx, page, errors } = await newPage({ height: 400 });
  try {
    await page.goto(`${server.origin}${RESULT_PATH}`, {
      waitUntil: 'domcontentloaded',
    });
    await page.waitForSelector('button:has-text("展開選項")', {
      timeout: 20_000,
    });

    // 對照組:頁面真的捲得動。
    const scrollable = await page.evaluate(
      () => document.documentElement.scrollHeight - window.innerHeight,
    );
    assert.ok(scrollable > 50, `頁面捲不動(可捲 ${scrollable}px),測不到還原`);

    // 捲到第二張卡再點它 —— 已經在畫面內,所以 click() 不會再自己捲一次,
    // 記下來的 y 才等於離開時的 y。
    const row = page.locator(`a[href="/q/${Q2.question_id}"]`).first();
    await row.scrollIntoViewIfNeeded();
    const y0 = await page.evaluate(() => window.scrollY);
    assert.ok(y0 > 0, '沒有捲動,還原什麼都不做也會通過');

    await row.click();
    await page.waitForSelector(`text=這是第 ${Q2.number} 題的題幹`, {
      timeout: 20_000,
    });
    // 題目頁先歸零。不歸零的話「還原」與「本來就停在那裡」分不出來 ——
    // SPA 導覽不會自己重設 window.scrollY。
    await page.evaluate(() => window.scrollTo(0, 0));

    await backLink(page).first().click();
    await page.waitForFunction((p) => location.pathname === p, RESULT_PATH, {
      timeout: 10_000,
    });
    await page.waitForFunction((y) => Math.abs(window.scrollY - y) <= 4, y0, {
      timeout: 10_000,
    });

    assert.deepEqual(errors, []);
  } finally {
    await ctx.close();
  }
});

test('走回成績頁時篩選也還原 —— 否則那個 y 是落在別份清單上', async (t) => {
  if (skipReason) {
    if (REQUIRE) assert.fail(`E2E_REQUIRE=1 但無法執行:${skipReason}`);
    return t.skip(skipReason);
  }

  const { ctx, page, errors } = await newPage();
  const answered = EXAM.answers.find((a) => a.is_correct === 1);
  const row = (id) => page.locator(`a[href="/q/${id}"]`).first();
  try {
    await page.goto(`${server.origin}${RESULT_PATH}`, {
      waitUntil: 'domcontentloaded',
    });
    await page.waitForSelector('button:has-text("展開選項")', {
      timeout: 20_000,
    });

    // 對照組:預設篩選是「答錯/未答」,考對的那題本來就不在畫面上。
    assert.equal(
      await row(answered.question_id).count(),
      0,
      '預設篩選下不該看得到考對的題目 —— 底下的斷言會恆真',
    );

    await page.locator('button', { hasText: '全部 (' }).click();
    await row(answered.question_id).waitFor({ timeout: 10_000 });
    await row(answered.question_id).click();
    await page.waitForSelector(`text=這是第 ${answered.number} 題的題幹`, {
      timeout: 20_000,
    });

    await backLink(page).first().click();
    await page.waitForFunction((p) => location.pathname === p, RESULT_PATH, {
      timeout: 10_000,
    });
    // 篩選沒還原的話這一列不會存在(它只在「全部」底下)。
    await row(answered.question_id).waitFor({ timeout: 10_000 });

    assert.deepEqual(errors, []);
  } finally {
    await ctx.close();
  }
});

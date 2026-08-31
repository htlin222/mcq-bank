// 成績頁每一列的第二顆懸浮鈕:「查看詳解」——不離開清單就把詳解看完。
//
// 這支守的是三件事,而第二件是這個功能會不會存在的關鍵:
//
//   1. 有指標的裝置上跟隔壁那顆一樣,hover 才現身(檢討時每一列都會看,但
//      「看詳解」不是每一列都要)。
//   2. **觸控裝置上不用 hover 就看得見。** 隔壁那顆在觸控上看不見是可以的 ——
//      長按整列本來就有系統的「在新分頁開啟」。這顆沒有任何平台等價物,
//      藏起來等於手機上根本沒有這個功能,而手機正是最需要它的地方。
//      Playwright 的 `hasTouch: true` 會讓 `(hover: none)` 成立(兩個引擎都是),
//      所以這條測得到。
//   3. 沒有詳解的題目要**明講**,不是開一個空白對話框。
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
const [Q1, Q2] = EXAM.answers;

const PEEK_TEXT = '快速看詳解的內容標記字串';

function docWith(text) {
  return JSON.stringify({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  });
}

/** 借 113-050 的形狀。第二題刻意沒有詳解 —— 空狀態也要有人守。 */
function payload(a) {
  const withExplanation = a.question_id === Q1.question_id;
  return {
    ...BASE,
    id: a.question_id,
    number: a.number,
    stem: `這是第 ${a.number} 題的題幹`,
    explanation: withExplanation
      ? {
          ...BASE.explanation,
          question_id: a.question_id,
          content_json: docWith(PEEK_TEXT),
        }
      : null,
    my_note: null,
    my_notes: [],
  };
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

/** 等到 `probe()` 為真,或逾時 —— 預抓是背景行為,頁面上看不到它。 */
async function until(probe, ms = 5_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (probe()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

async function open(contextOptions = {}) {
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    serviceWorkers: 'block',
    ...contextOptions,
  });
  await ctx.route('**/*', (r) =>
    r.request().url().startsWith(server.origin) ? r.continue() : r.abort(),
  );
  const json = (route, body) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify(body),
    });
  // 附屬端點沒有 fixture,伺服器回 `{}`,而消費端是 `.map()`。
  await ctx.route('**/api/questions/113-0*/*', (route) => json(route, []));
  // 題目 payload 由 ctx.route 直接答覆,所以數不到伺服器那邊 —— 在這裡記。
  const hits = [];
  for (const a of EXAM.answers) {
    await ctx.route(`**/api/questions/${a.question_id}`, (route) => {
      hits.push(a.question_id);
      return json(route, payload(a));
    });
  }
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${server.origin}${RESULT_PATH}`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForSelector('button:has-text("展開選項")', { timeout: 20_000 });
  return { ctx, page, errors, hits };
}

const peekBtn = (page, n) =>
  page.locator(`button[aria-label="查看第 ${n} 題的詳解"]`);

test('有指標的裝置:hover 才現身,點開就看得到詳解,Esc 關得掉', async (t) => {
  if (skipReason) {
    if (REQUIRE) assert.fail(`E2E_REQUIRE=1 但無法執行:${skipReason}`);
    return t.skip(skipReason);
  }

  const { ctx, page, errors } = await open();
  try {
    const btn = peekBtn(page, Q1.number);
    // 空掃防線:先確認這顆真的在,底下的 opacity 才有話語權。
    await btn.waitFor({ state: 'attached', timeout: 10_000 });

    // 用 opacity 量而不是 toBeVisible —— `opacity-0` 的元素在 Playwright 眼裡
    // 仍然是 visible(有尺寸、沒有 display:none),那樣寫兩邊都會通過。
    const opacity = () => btn.evaluate((el) => getComputedStyle(el).opacity);
    assert.equal(await opacity(), '0', 'hover 之前不該看得見');
    await page.locator('ul li').first().hover();
    await page.waitForTimeout(300);
    assert.equal(await opacity(), '1', 'hover 之後該看得見');

    await btn.click();
    const dialog = page.locator('[role="dialog"]');
    await dialog.waitFor({ timeout: 10_000 });
    await page.waitForSelector(`text=${PEEK_TEXT}`, { timeout: 10_000 });
    // 題幹也要在:清單上那一列是 line-clamp-2,只看詳解讀不懂。
    assert.match(await dialog.innerText(), new RegExp(`第 ${Q1.number} 題`));
    assert.match(await dialog.innerText(), /這是第 1 題的題幹/);

    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached', timeout: 5_000 });

    assert.deepEqual(errors, []);
  } finally {
    await ctx.close();
  }
});

test('觸控裝置:不必 hover 就看得見,而且對話框吃滿螢幕高度', async (t) => {
  if (skipReason) {
    if (REQUIRE) assert.fail(`E2E_REQUIRE=1 但無法執行:${skipReason}`);
    return t.skip(skipReason);
  }

  const H = 844;
  const { ctx, page, errors } = await open({
    viewport: { width: 390, height: H },
    hasTouch: true,
  });
  try {
    // 對照組:這個 context 真的被當成沒有 hover 的裝置。少了它,下面那個 '1'
    // 也可能只是因為某個地方順手 hover 到了。
    assert.equal(
      await page.evaluate(() => matchMedia('(hover: none)').matches),
      true,
      'context 沒有被當成觸控裝置,這條測不到東西',
    );

    const btn = peekBtn(page, Q1.number);
    await btn.waitFor({ state: 'attached', timeout: 10_000 });
    assert.equal(
      await btn.evaluate((el) => getComputedStyle(el).opacity),
      '1',
      '觸控裝置上看不見 —— 手機上等於沒有這個功能',
    );

    await btn.click();
    const dialog = page.locator('[role="dialog"]');
    await dialog.waitFor({ timeout: 10_000 });
    await page.waitForSelector(`text=${PEEK_TEXT}`, { timeout: 10_000 });

    const box = await dialog.boundingBox();
    assert.ok(
      box.height >= H - 2,
      `手機上要滿版:量到 ${box.height},視窗 ${H}`,
    );

    assert.deepEqual(errors, []);
  } finally {
    await ctx.close();
  }
});

test('沒有詳解的題目要明講,不是開一個空白對話框', async (t) => {
  if (skipReason) {
    if (REQUIRE) assert.fail(`E2E_REQUIRE=1 但無法執行:${skipReason}`);
    return t.skip(skipReason);
  }

  const { ctx, page, errors } = await open();
  try {
    const btn = peekBtn(page, Q2.number);
    await btn.waitFor({ state: 'attached', timeout: 10_000 });
    await btn.click({ force: true });
    const dialog = page.locator('[role="dialog"]');
    await dialog.waitFor({ timeout: 10_000 });
    await page.waitForSelector('text=這一題還沒有共筆詳解', { timeout: 10_000 });
    // 而且要給一條出路,不是死路。
    assert.match(await dialog.innerText(), /去寫一則詳解/);

    assert.deepEqual(errors, []);
  } finally {
    await ctx.close();
  }
});

test('指標一碰就開抓,而且點下去真的用到了那一份', async (t) => {
  if (skipReason) {
    if (REQUIRE) assert.fail(`E2E_REQUIRE=1 但無法執行:${skipReason}`);
    return t.skip(skipReason);
  }

  const { ctx, page, errors, hits } = await open();
  const mine = () => hits.filter((id) => id === Q1.question_id).length;
  try {
    // 對照組:成績頁本身不抓題目 payload。少了這一步,底下的「1」可能只是
    // 頁面載入順手抓的,而跟預抓一點關係都沒有。
    assert.equal(mine(), 0, '還沒碰按鈕就抓了 —— 這條測不到預抓');

    await peekBtn(page, Q1.number).hover();
    assert.ok(await until(() => mine() >= 1), '指標碰到之後沒有開抓');
    assert.equal(mine(), 1, '碰一下抓了不只一次');

    // ⚠️ 這條才是重點:點下去**不能**再抓一次。只驗「碰了會抓」的話,一個
    // 「抓完就丟、點擊時重抓」的實作也會全綠 —— 而那沒有省下任何等待。
    await peekBtn(page, Q1.number).click();
    await page.waitForSelector(`text=${PEEK_TEXT}`, { timeout: 10_000 });
    assert.equal(mine(), 1, '點下去又抓了一次 —— 預抓沒有被用到');

    assert.deepEqual(errors, []);
  } finally {
    await ctx.close();
  }
});

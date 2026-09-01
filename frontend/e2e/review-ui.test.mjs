// 檢討介面在**每一個清單頁**上都要是同一套:展開選項、hover 開新分頁、彈出詳解。
//
// 回報先是「錯題回顧也要像全真對答案一樣」,接著是「搜尋也要」。所以這支不是
// 「錯題頁的測試」,是**「這些頁面提供的東西一樣嗎」** —— 用一張表跑過每一頁。
// 新增一個用到 AnswerOptions / QuestionRowActions 的清單頁時,在 PAGES 加一列
// 就好;漏加的話,那一頁的接線沒有任何防線。
//
// ⚠️ **不重驗共用元件的內部行為**(選項配色、分布長條、對話框吃滿螢幕高度)——
// 那些在 `exam-result-options` / `exam-result-peek` 那兩支裡。這支只回答
// 「接上了嗎」,所以每一條都盡量短。
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

function fixture(name) {
  return JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', name), 'utf8'));
}

function title(r) {
  return `${r.year}-${String(r.number).padStart(3, '0')}`;
}

const WEAKNESS = fixture('review_weakness-map.json');

// 每一頁一列。`rows` 直接從 fixture 讀 —— 寫死期望值的話,fixture 一改這支就
// 靜靜地驗到別的東西上(gamepad 那條踩過)。
//
// `prepare` 是「讓那些列出現在畫面上」要先做的事。弱點地圖預設是收合的
// (那一頁的價值是總覽),所以要先把每一群點開 —— 少了這一步,每一條都會紅在
// 「找不到列」而不是功能上。
const PAGES = [
  {
    name: '錯題回顧',
    path: '/wrong',
    rows: fixture('review_wrong.json'),
  },
  {
    name: '搜尋',
    // 沒有 q 就不會送出查詢,結果區整塊不渲染。
    path: '/search?q=' + encodeURIComponent('白血病'),
    rows: fixture('search.json').items,
  },
  {
    name: '弱點地圖',
    path: '/weakness-map',
    rows: WEAKNESS.clusters[0].question_ids.map((id) => WEAKNESS.questions[id]),
    async prepare(page) {
      for (const cl of WEAKNESS.clusters) {
        await page
          .getByRole('button', { name: `看這 ${cl.size} 題`, exact: true })
          .click();
      }
    },
  },
];

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

/**
 * 開一頁,並回傳「第一列」與「指定題號那一列」的定位器。
 *
 * 空掃防線在這裡:清單真的載出來了才回去。少了它,底下每一條「找不到就紅」的
 * 斷言都會紅在一個看起來像功能壞掉、其實是 fixture 沒到的地方。
 */
async function open(t, P, viewport = { width: 1280, height: 900 }, touch = false) {
  const ctx = await browser.newContext({
    viewport,
    serviceWorkers: 'block',
    ...(touch ? { isMobile: true, hasTouch: true } : {}),
  });
  await ctx.route('**/*', (r) =>
    r.request().url().startsWith(server.origin) ? r.continue() : r.abort(),
  );
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(server.origin + P.path, { waitUntil: 'domcontentloaded' });
  if (P.prepare) {
    // 空掃防線:準備動作自己要找得到東西。點不到的話底下會紅在「找不到列」,
    // 而那看起來像功能壞掉。
    await page.locator('h1').first().waitFor({ timeout: 20_000 });
    await P.prepare(page);
  }

  const rowOf = (r) => page.locator('ul li').filter({ hasText: title(r) }).first();
  const row = rowOf(P.rows[0]);
  await row.waitFor({ timeout: 20_000 });
  t.after(async () => {
    await ctx.close();
  });
  return { ctx, page, errors, row, rowOf };
}

for (const P of PAGES) {
  const R0 = P.rows[0];

  test(`${P.name}:展開選項 —— 選項全文就地顯示,正解與自己選的都標出來`, async (t) => {
    if (guard(t)) return;
    const { ctx, page, errors, row } = await open(t, P);
    try {
      const toggle = row.getByRole('button', { name: '展開選項', exact: true });
      await toggle.waitFor({ timeout: 10_000 });

      // 對照組:展開之前選項文字不在畫面上,否則「展開之後看得到」恆真。
      const anOption = R0.options[R0.correct_answer];
      assert.ok(anOption, 'fixture 的正解沒有對應的選項文字,這條驗不到東西');
      assert.ok(
        !(await row.innerText()).includes(anOption),
        '還沒展開就已經看得到選項全文了',
      );

      await toggle.click();
      await page.waitForTimeout(300);
      const text = await row.innerText();
      assert.ok(text.includes(anOption), `展開後看不到選項全文:${text.slice(0, 160)}`);
      assert.match(text, /✓ 正解/, '正解沒有標出來');
      assert.notEqual(R0.last_chosen, R0.correct_answer, 'fixture 第一列必須是答錯的');
      assert.match(text, /你選的/, '沒有標出「你選的」—— last_chosen 沒有接上');
      assert.deepEqual(errors, []);
    } finally {
      await ctx.close();
    }
  });

  test(`${P.name}:展開全部選項 —— 一次推開所有卡片`, async (t) => {
    if (guard(t)) return;
    const { ctx, page, errors } = await open(t, P);
    try {
      const collapsed = () =>
        page.getByRole('button', { name: '展開選項', exact: true }).count();
      const before = await collapsed();
      assert.equal(
        before,
        P.rows.length,
        `一開始應該有 ${P.rows.length} 個收合的卡片,實際 ${before}`,
      );

      await page.getByRole('button', { name: '展開全部選項', exact: true }).click();
      await page.waitForTimeout(300);
      assert.equal(await collapsed(), 0, '「展開全部選項」沒有把每一題都推開');

      await page.getByRole('button', { name: '收合全部選項', exact: true }).click();
      await page.waitForTimeout(300);
      assert.equal(await collapsed(), P.rows.length, '收合全部沒有把每一題收回去');
      assert.deepEqual(errors, []);
    } finally {
      await ctx.close();
    }
  });

  test(`${P.name}:不展開也看得到「我當初選了哪一個」`, async (t) => {
    if (guard(t)) return;
    // 這一行是三頁共用的 AnswerVerdict。少了它,「我錯在哪」得先展開選項才看得到
    // —— 而成績頁那一列一眼就講完了。
    const { ctx, errors, row } = await open(t, P);
    try {
      const text = await row.innerText();
      assert.match(
        text,
        new RegExp(`✗ 你選 ${R0.last_chosen} · 正解 ${R0.correct_answer}`),
        `列上沒有判定那一行:${text.slice(0, 160)}`,
      );
      assert.deepEqual(errors, []);
    } finally {
      await ctx.close();
    }
  });

  test(`${P.name}:hover 才出現「在新分頁開啟」,而且沒有巢狀在整列連結裡`, async (t) => {
    if (guard(t)) return;
    const { ctx, page, errors, row } = await open(t, P);
    try {
      const btn = row.locator('a[target="_blank"]').first();
      await btn.waitFor({ state: 'attached', timeout: 10_000 });

      // ⚠️ 巢狀 `<a>` 是無效 HTML,而症狀是靜默的:瀏覽器解析時會把內層拉到外層
      // 之外,按鈕就跑到列的上面。拿掉 `relative group` 的包裝時這條會紅。
      const nested = await btn.evaluate((el) => {
        let p = el.parentElement;
        while (p) {
          if (p.tagName === 'A') return true;
          if (p.tagName === 'LI') return false;
          p = p.parentElement;
        }
        return false;
      });
      assert.equal(nested, false, '「在新分頁開啟」不該巢狀在整列連結裡');
      assert.equal(await btn.getAttribute('href'), `/q/${R0.id}`);
      assert.equal(await btn.getAttribute('rel'), 'noreferrer');

      // 用 opacity 量而不是 toBeVisible —— `opacity-0` 的元素在 Playwright 眼裡
      // 仍然是 visible(有尺寸、沒有 display:none),那樣寫兩邊都會通過。
      const opacity = () => btn.evaluate((el) => getComputedStyle(el).opacity);
      assert.equal(await opacity(), '0', 'hover 之前不該看得見');
      await row.hover();
      await page.waitForTimeout(300);
      assert.equal(await opacity(), '1', 'hover 之後該看得見');
      assert.deepEqual(errors, []);
    } finally {
      await ctx.close();
    }
  });

  test(`${P.name}:查看詳解 —— 不離開清單就看完,標題是題號而不是「第 N 題」`, async (t) => {
    if (guard(t)) return;
    // 113-001 是唯一有真共筆詳解 fixture 的題目(questions_113-001.json)。
    const target = P.rows.find((r) => r.id === '113-001');
    assert.ok(target, `${P.name} 的 fixture 少了 113-001,這條沒有詳解內容可驗`);
    const label = title(target);

    const { ctx, page, errors, rowOf } = await open(t, P);
    try {
      await rowOf(target)
        .getByRole('button', { name: `查看${label}的詳解`, exact: true })
        .click();

      const dialog = page.locator('[role="dialog"]');
      await dialog.waitFor({ timeout: 10_000 });
      const text = await dialog.innerText();
      // ⚠️ 標題必須是 `113-001`,不是「第 1 題」—— 這些清單跨年份,單獨一個 `1`
      // 指不到任何一題。ExplanationPeek 從 `number` 改吃 `label` 就是為了這個。
      assert.ok(text.includes(label), `對話框標題不是題號:${text.slice(0, 80)}`);
      assert.ok(!/第 1 題/.test(text), '標題退回成「第 N 題」了');
      assert.match(text, /凝血因子的鑑別診斷/, '對話框裡沒有那一題的共筆詳解');
      assert.ok(
        page.url().includes(P.path.split('?')[0]),
        `不該離開清單:${page.url()}`,
      );

      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'detached', timeout: 5_000 });
      assert.deepEqual(errors, []);
    } finally {
      await ctx.close();
    }
  });

  test(`${P.name}:觸控裝置 ——「查看詳解」不必 hover 就看得見`, async (t) => {
    if (guard(t)) return;
    // 它沒有任何平台等價物 —— 藏起來等於手機上根本沒有這個功能,而手機正是
    // 「不想離開清單」最強烈的地方。「在新分頁開啟」則相反:長按整列本來就有。
    const { ctx, errors, row } = await open(t, P, { width: 390, height: 780 }, true);
    try {
      const peek = row.getByRole('button', {
        name: `查看${title(R0)}的詳解`,
        exact: true,
      });
      await peek.waitFor({ timeout: 10_000 });
      assert.equal(
        await peek.evaluate((el) => getComputedStyle(el).opacity),
        '1',
        '觸控裝置上「查看詳解」應該預設就看得見',
      );
      assert.deepEqual(errors, []);
    } finally {
      await ctx.close();
    }
  });
}

// 這一頁獨有的行為,不進上面那張表。
//
// ⚠️ **`prepare` 會把每一群點開,所以表裡那六條看不到「預設是不是收合的」** ——
// 一個「永遠攤開」的實作在那六條底下全綠。這一頁的價值是「一眼看到自己弱在哪」,
// 一進來就攤開 60 題等於把那個總覽埋掉。
test('弱點地圖:預設收合 —— 總覽不會被 60 題埋掉', async (t) => {
  if (guard(t)) return;
  const P = PAGES.find((x) => x.name === '弱點地圖');
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    serviceWorkers: 'block',
  });
  await ctx.route('**/*', (r) =>
    r.request().url().startsWith(server.origin) ? r.continue() : r.abort(),
  );
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    await page.goto(server.origin + P.path, { waitUntil: 'domcontentloaded' });

    // 對照組:分群卡片真的畫出來了。少了它,「看不到題目」在整頁空白時也成立。
    const toggle = page.getByRole('button', {
      name: `看這 ${WEAKNESS.clusters[0].size} 題`,
      exact: true,
    });
    await toggle.waitFor({ timeout: 20_000 });

    const stem = WEAKNESS.questions[WEAKNESS.clusters[0].question_ids[0]].stem;
    assert.ok(
      !(await page.locator('body').innerText()).includes(stem.slice(0, 20)),
      '一進來就把題目攤開了 —— 弱點總覽會被埋掉',
    );

    // 而且點下去真的會出現(否則上面那個「看不到」什麼都沒證明)。
    await toggle.click();
    await page.waitForTimeout(300);
    assert.ok(
      (await page.locator('body').innerText()).includes(stem.slice(0, 20)),
      '點了「看這 N 題」還是看不到題目',
    );
    assert.deepEqual(errors, []);
  } finally {
    await ctx.close();
  }
});

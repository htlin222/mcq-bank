// 錯題回顧要跟「全真對答案」是同一套檢討介面。
//
// 回報的原話是「也像在全真對答案一樣的 UI」:展開選項、hover 開新分頁、彈出詳解。
// 那三件事在成績頁上都已經有了(`exam-result-options` / `exam-result-peek` 各驗
// 一份),而這支驗的是**它們真的也長在錯題回顧上** —— 共用元件抽對了沒有,只有
// 在第二個呼叫端上才看得出來。
//
// ⚠️ **不重驗共用元件的內部行為**(選項配色、分布長條、對話框吃滿螢幕高度)——
// 那些在成績頁那兩支裡。這支只回答「接上了嗎」,所以每一條都盡量短。
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

// fixture 的第一列。選項/正解/我上次選的都跟著 `/api/review/wrong` 一起回來 ——
// 從這裡讀而不是寫死,fixture 一改這支就跟著走(同 gamepad 那條 fixture 教訓)。
const ROWS = JSON.parse(
  fs.readFileSync(path.join(HERE, 'fixtures', 'review_wrong.json'), 'utf8'),
);
const R0 = ROWS[0];
const TITLE0 = `${R0.year}-${String(R0.number).padStart(3, '0')}`;

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

async function open(t, viewport = { width: 1280, height: 900 }, touch = false) {
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
  await page.goto(`${server.origin}/wrong`, { waitUntil: 'domcontentloaded' });
  // 空掃防線:清單真的載出來了。少了它,底下每一條「找不到就紅」的斷言都會紅在
  // 一個看起來像功能壞掉、其實是 fixture 沒到的地方。
  const rows = page.locator('ul li').filter({ hasText: TITLE0 });
  await rows.first().waitFor({ timeout: 20_000 });
  t.after(async () => {
    await ctx.close();
  });
  return { ctx, page, errors, row: rows.first() };
}

test('展開選項:選項全文就地顯示,正解與自己選的都標出來', async (t) => {
  if (guard(t)) return;
  const { ctx, page, errors, row } = await open(t);
  try {
    const toggle = row.getByRole('button', { name: '展開選項' });
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
    // fixture 刻意讓 last_chosen ≠ 正解 —— 那正是「錯題」的定義。
    assert.notEqual(R0.last_chosen, R0.correct_answer);
    assert.match(text, /你選的/, '沒有標出「你選的」—— last_chosen 沒有接上');
    assert.deepEqual(errors, []);
  } finally {
    await ctx.close();
  }
});

test('展開全部選項:一次推開所有卡片', async (t) => {
  if (guard(t)) return;
  const { ctx, page, errors } = await open(t);
  try {
    const collapsed = () => page.getByRole('button', { name: '展開選項' }).count();
    const before = await collapsed();
    assert.equal(before, ROWS.length, `一開始應該有 ${ROWS.length} 個收合的卡片,實際 ${before}`);

    await page.getByRole('button', { name: '展開全部選項' }).click();
    await page.waitForTimeout(300);
    assert.equal(await collapsed(), 0, '「展開全部選項」沒有把每一題都推開');

    await page.getByRole('button', { name: '收合全部選項' }).click();
    await page.waitForTimeout(300);
    assert.equal(await collapsed(), ROWS.length, '收合全部沒有把每一題收回去');
    assert.deepEqual(errors, []);
  } finally {
    await ctx.close();
  }
});

test('hover 才出現「在新分頁開啟」,而且它沒有被巢狀在整列連結裡', async (t) => {
  if (guard(t)) return;
  const { ctx, page, errors, row } = await open(t);
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

test('查看詳解:不離開清單就看完,標題是題號而不是「第 N 題」', async (t) => {
  if (guard(t)) return;
  // 第二列是 113-001 —— 那份 fixture 有真的共筆詳解內容可以斷言。
  const target = ROWS.find((r) => r.id === '113-001');
  assert.ok(target, 'fixture 少了 113-001,這條沒有詳解內容可驗');
  const title = `${target.year}-${String(target.number).padStart(3, '0')}`;

  const { ctx, page, errors } = await open(t);
  try {
    const row = page.locator('ul li').filter({ hasText: title }).first();
    await row.getByRole('button', { name: `查看${title}的詳解` }).click();

    const dialog = page.locator('[role="dialog"]');
    await dialog.waitFor({ timeout: 10_000 });
    const text = await dialog.innerText();
    // ⚠️ 標題必須是 `113-001`,不是「第 1 題」—— 這份清單跨年份,單獨一個 `1`
    // 指不到任何一題。ExplanationPeek 從 `number` 改吃 `label` 就是為了這個。
    assert.ok(text.includes(title), `對話框標題不是題號:${text.slice(0, 80)}`);
    assert.ok(!/第 1 題/.test(text), '標題退回成「第 N 題」了');
    assert.match(text, /凝血因子的鑑別診斷/, '對話框裡沒有那一題的共筆詳解');
    assert.ok(page.url().endsWith('/wrong'), `不該離開清單:${page.url()}`);

    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached', timeout: 5_000 });
    assert.deepEqual(errors, []);
  } finally {
    await ctx.close();
  }
});

test('觸控裝置:「查看詳解」不必 hover 就看得見', async (t) => {
  if (guard(t)) return;
  // 它沒有任何平台等價物 —— 藏起來等於手機上根本沒有這個功能,而手機正是
  //「不想離開清單」最強烈的地方。「在新分頁開啟」則相反:長按整列本來就有。
  const { ctx, page, errors, row } = await open(t, { width: 390, height: 780 }, true);
  try {
    const peek = row.getByRole('button', { name: `查看${TITLE0}的詳解` });
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

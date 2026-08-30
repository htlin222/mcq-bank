// 全真作答換題時要捲回題幹。
//
// 不捲的話,答完一題往下捲看完選項再按「下一題」,下一題會從**選項中段**開始顯示
// —— 題幹在畫面外,而使用者不會馬上發現自己漏讀了題目。
//
// ⚠️ 修正掛在 `activeIdx` 的變化上,不是掛在按鈕上 —— 上一題/下一題、題號跳轉、
// 手把的 L1/R1 全都只是改那個 state。所以這支**三條路徑都要測**:只測按鈕的話,
// 「一個一個補 onClick」那種做法也會全綠,而它遲早會漏掉一條。
//
// ⚠️ `running_since` 是絕對時間戳,靜態 fixture 給什麼都會過期(給過去的時間會
// 一進頁面就自動交卷,給 null 則整份題目不渲染)。所以 fixture 只提供形狀,
// 「現在」由測試在請求當下注入 —— 同 exam-timer-bar.test.mjs。
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

const STATE = JSON.parse(
  fs.readFileSync(path.join(HERE, 'fixtures', 'exam_e2e-1_state.json'), 'utf8'),
);

async function serveFreshState(ctx) {
  await ctx.route('**/api/exam/e2e-1/state', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify({ ...STATE, running_since: Date.now(), elapsed_ms: 60_000 }),
    }),
  );
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

function guard(t) {
  if (!skipReason) return false;
  if (REQUIRE) assert.fail(`E2E_REQUIRE=1 但無法執行:${skipReason}`);
  t.skip(skipReason);
  return true;
}

/** 視窗刻意壓矮,否則這一頁捲不動,「捲動後」與「捲動前」是同一個狀態,斷言恆真。 */
async function openExam(page) {
  await page.goto(server.origin + '/exam/e2e-1', { waitUntil: 'domcontentloaded' });
  await page.locator('button', { hasText: '下一題' }).first().waitFor({ timeout: 20_000 });
  // 等版面穩定再量:字型與圖片還在載時頁高會偏低,那條前置斷言就會假紅。
  await page.waitForTimeout(400);
  const scrollable = await page.evaluate(
    () => document.documentElement.scrollHeight - window.innerHeight,
  );
  assert.ok(
    scrollable > 200,
    `這一頁要真的捲得動,測試才有意義(可捲 ${scrollable}px)`,
  );
}

const SCROLL_Y = `window.scrollY`;

async function scrollDown(page) {
  await page.evaluate(() => window.scrollTo(0, 400));
  await page.waitForTimeout(120);
  const y = await page.evaluate(SCROLL_Y);
  // 對照組:捲動本身要成立。少了它,底下的 `=== 0` 在「頁面根本捲不動」時也會過。
  assert.ok(y > 100, `該捲得下去,實際 scrollY=${y}`);
  return y;
}

test('按「下一題」會捲回題幹', async (t) => {
  if (guard(t)) return;
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 420 },
    isMobile: true,
    hasTouch: true,
    serviceWorkers: 'block',
  });
  await serveFreshState(ctx);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    await openExam(page);
    await scrollDown(page);

    await page.locator('button', { hasText: '下一題' }).first().click();
    await page.waitForTimeout(250);
    assert.equal(await page.evaluate(SCROLL_Y), 0, '換題之後該回到最上面');

    assert.deepEqual(errors, [], '不該有未捕捉的例外');
  } finally {
    await ctx.close();
  }
});

test('按「上一題」也一樣', async (t) => {
  if (guard(t)) return;
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 420 },
    isMobile: true,
    hasTouch: true,
    serviceWorkers: 'block',
  });
  await serveFreshState(ctx);
  const page = await ctx.newPage();
  try {
    await openExam(page);
    // 先往後一題,「上一題」才不是 disabled。
    await page.locator('button', { hasText: '下一題' }).first().click();
    await page.waitForTimeout(200);
    await scrollDown(page);

    await page.locator('button', { hasText: '上一題' }).first().click();
    await page.waitForTimeout(250);
    assert.equal(await page.evaluate(SCROLL_Y), 0, '往回一題也該回到最上面');
  } finally {
    await ctx.close();
  }
});

test('從「題號跳轉」跳過去也會捲回題幹', async (t) => {
  if (guard(t)) return;
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 420 },
    isMobile: true,
    hasTouch: true,
    serviceWorkers: 'block',
  });
  await serveFreshState(ctx);
  const page = await ctx.newPage();
  try {
    await openExam(page);

    // ⚠️ 這一條是重點:它證明修正掛在 activeIdx 上,而不是掛在那兩顆按鈕上。
    // 「一個一個補 onClick」的做法在上面兩支測試裡也會全綠。
    const details = page.locator('details').first();
    await details.locator('summary').click();
    await page.waitForTimeout(200);
    await scrollDown(page);

    const cell = page.locator('details button', { hasText: /^12$/ }).first();
    await cell.waitFor({ timeout: 5_000 });
    await cell.click();
    await page.waitForTimeout(250);
    assert.equal(
      await page.evaluate(SCROLL_Y),
      0,
      '從題號跳轉跳過去也該回到最上面',
    );
  } finally {
    await ctx.close();
  }
});

test('本題計時:會走,而且換題歸零', async (t) => {
  if (guard(t)) return;
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 420 },
    isMobile: true,
    hasTouch: true,
    serviceWorkers: 'block',
  });
  await serveFreshState(ctx);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    await openExam(page);

    const timer = page.locator('[data-testid="question-timer"]');
    await timer.waitFor({ timeout: 10_000 });

    // ⚠️ **對照組要先證明它真的在走。** 少了這一段,「換題之後是 0:0x」在計時器
    // 根本沒動、永遠停在 0:00 時也會成立 —— 整支測試就退化成空掃的綠燈。
    await page.waitForFunction(
      () => {
        const el = document.querySelector('[data-testid="question-timer"]');
        return el && /本題 0:0[3-9]/.test(el.textContent || '');
      },
      { timeout: 12_000 },
    );
    const ran = (await timer.innerText()).trim();

    await page.locator('button', { hasText: '下一題' }).first().click();
    await page.waitForTimeout(300);
    const after = (await timer.innerText()).trim();

    assert.notEqual(after, ran, `換題之後該歸零(換題前 ${ran},換題後 ${after})`);
    assert.match(
      after,
      /本題 0:0[01]/,
      `換題之後該回到 0 附近,實際:${after}`,
    );

    // 換題那一瞬間 timer 已重設但取樣的 now 還停在上一秒 —— read() 會回一個小
    // 負數。formatElapsed 夾到 0,所以畫面上不該出現負號。
    assert.ok(!after.includes('-'), `不該顯示負數,實際:${after}`);

    assert.deepEqual(errors, [], '不該有未捕捉的例外');
  } finally {
    await ctx.close();
  }
});

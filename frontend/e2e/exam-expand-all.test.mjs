// 成績頁篩選列右邊的「展開全部選項 / 收合全部選項」。
//
// 檢討整份考卷時,一題一題點開選項是 100 次點擊。這顆把所有卡片推到同一個狀態,
// **但不鎖住個別的開關** —— 展開全部之後仍然可以單獨收合某一題。
//
// 三個刻意的形狀:
//
//   1. **先斷言展開前看不到選項文字**(同 exam-result-options):少了前半段,
//      一個「永遠都畫出來」的實作也會全綠。
//   2. **展開全部之後再單獨收合一題,其餘要留著**。少了這條,一個「把 open 綁死在
//      expandAll 上」的實作也會通過 —— 而那的症狀是「按了單題收合沒反應」。
//   3. 篩選列繞著窄螢幕取樣,斷言頁面沒有被撐出水平捲軸:這顆按鈕是加在一列
//      本來就快滿的東西後面。
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
const FIXTURE = JSON.parse(
  fs.readFileSync(path.join(HERE, 'fixtures', `exam_${SID}.json`), 'utf8'),
);
// 預設篩選是「答錯/未答」—— 期望值從 fixture 推出來,不要手寫一個會過期的數字。
const WRONG = FIXTURE.answers.filter((a) => a.is_correct !== 1);

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

async function openResult(width = 1280) {
  const ctx = await browser.newContext({
    viewport: { width, height: 900 },
    serviceWorkers: 'block',
  });
  await ctx.route('**/*', (r) =>
    r.request().url().startsWith(server.origin) ? r.continue() : r.abort(),
  );
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${server.origin}/exam/${SID}/result`, { waitUntil: 'domcontentloaded' });
  await page.locator('button', { hasText: '展開選項' }).first().waitFor({ timeout: 20_000 });
  return { ctx, page, errors };
}

test('展開全部 / 收合全部:一顆按鈕推動所有卡片', async (t) => {
  if (skipReason) {
    if (REQUIRE) assert.fail(`E2E_REQUIRE=1 但無法執行:${skipReason}`);
    return t.skip(skipReason);
  }

  const { ctx, page, errors } = await openResult();
  try {
    const btn = page.locator('button', { hasText: /展開全部選項|收合全部選項/ });
    assert.equal(await btn.count(), 1, '找不到「展開全部選項」按鈕');
    assert.equal(await btn.innerText(), '展開全部選項', '初始狀態應該是收合');

    const bodyText = () => page.evaluate(() => document.body.innerText);
    const shown = async () => {
      const t = await bodyText();
      return WRONG.filter((a) => t.includes(a.options.B)).length;
    };

    assert.equal(await shown(), 0, '還沒展開就看得到選項文字');

    await btn.click();
    await page.waitForTimeout(300);
    assert.equal(await shown(), WRONG.length, '按了展開全部,還是有卡片沒展開');
    assert.equal(await btn.innerText(), '收合全部選項', '按鈕沒有換成收合');

    await btn.click();
    await page.waitForTimeout(300);
    assert.equal(await shown(), 0, '按了收合全部,選項還在');
    assert.equal(await btn.innerText(), '展開全部選項');

    assert.deepEqual(errors, []);
  } finally {
    await ctx.close();
  }
});

test('展開全部之後,單獨收合一題不影響其他題', async (t) => {
  if (skipReason) {
    if (REQUIRE) assert.fail(`E2E_REQUIRE=1 但無法執行:${skipReason}`);
    return t.skip(skipReason);
  }
  if (WRONG.length < 2) assert.fail('fixture 至少要有兩題答錯,這條才有意義');

  const { ctx, page, errors } = await openResult();
  try {
    await page.locator('button', { hasText: '展開全部選項' }).click();
    await page.waitForTimeout(300);

    // 認 aria-controls 當把手:文字會隨狀態改寫,用文字選會選到別張卡(同
    // exam-result-options 那支踩過的坑)。
    const first = page.locator(`[aria-controls="opts-${WRONG[0].question_id}"]`);
    await first.click();
    await page.waitForTimeout(300);

    const t = await page.evaluate(() => document.body.innerText);
    assert.ok(!t.includes(WRONG[0].options.B), '單獨收合沒有生效 —— open 被綁死在 expandAll 上');
    assert.ok(t.includes(WRONG[1].options.B), '單獨收合把別題也一起收掉了');

    assert.deepEqual(errors, []);
  } finally {
    await ctx.close();
  }
});

for (const width of [320, 390, 639, 640]) {
  test(`篩選列多了一顆按鈕之後不撐出水平捲軸:${width}px`, async (t) => {
    if (skipReason) {
      if (REQUIRE) assert.fail(`E2E_REQUIRE=1 但無法執行:${skipReason}`);
      return t.skip(skipReason);
    }

    const { ctx, page } = await openResult(width);
    try {
      const btn = page.locator('button', { hasText: '展開全部選項' });
      assert.equal(await btn.count(), 1, '找不到按鈕 —— 底下的斷言會變成空掃');
      // 靠右:它的右緣要貼齊那一列的右緣(容差 1px 給邊框/四捨五入)。
      const gap = await btn.evaluate((el) => {
        const row = el.parentElement.getBoundingClientRect();
        return Math.round(row.right - el.getBoundingClientRect().right);
      });
      assert.ok(gap <= 1, `按鈕沒有靠右,離右緣還有 ${gap}px`);

      const over = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      assert.equal(over, 0, `${width}px 被撐出 ${over}px 的水平捲軸`);
    } finally {
      await ctx.close();
    }
  });
}

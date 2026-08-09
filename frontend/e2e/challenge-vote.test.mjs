// 「按下同意挑戰之後,畫面立刻承認你按了」的行為證據。
//
// 回報是「按下去 delay 了 30 秒才反應」。兩個成因疊在一起,而且只有一個是慢:
//
//   1. 投一票要走三趟序列往返 —— POST /votes,然後 GET /challenges/active +
//      GET /challenges 才更新橫幅。每一趟都是一次 Access 驗證過的 Worker 呼叫。
//   2. 這三趟跑完之前,那一列**沒有任何一個像素改變** —— 按鈕連 disabled 都
//      沒有。所以慢的時候看起來不是慢,是「沒按到」,而使用者的反應是再按一次。
//
// 這支測試把兩件事都釘住。伺服器每個 /api/ 延遲 1200ms,讓「請求還在飛」變成
// 一段可觀測的窗;loader 要在那段窗裡就上畫面,不是等回應回來才上。
//
// 兩條斷言都是**正面**的(看得到 spinner、看得到投票結果),不是「某個副作用
// 沒發生」—— 後者在整個面板根本沒渲染出來時也會通過。面板只在揭曉後才掛,所以
// 前面那段作答互動是承重的,不是鋪陳。

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(HERE, '..', 'dist');
const REQUIRE = process.env.E2E_REQUIRE === '1';

const API_DELAY_MS = 1200;
const QUESTION = '/q/113-050';
const OPTION_TEXT = '先生為亞孟買血型'; // 113-050 的正解 (B);選項是 <li> 不是 button
const ACTIVE_PATH = '/api/questions/113-050/challenges/active';

let browser = null;
let server = null;
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
  server = await startServer({ dist: DIST, apiDelayMs: API_DELAY_MS });
});

after(async () => {
  if (server) await server.close();
  if (browser) await browser.close();
});

/** 開題目頁 → 作答 → 揭曉 → 等挑戰橫幅上畫面。 */
async function openRevealedQuestion() {
  const { devices } = await import('playwright');
  const ctx = await browser.newContext({
    ...devices['Desktop Safari'],
    // SW 會插進 fetch 之間、也會自己去打 /api,apiHits 的計數會失準。
    serviceWorkers: 'block',
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.stack || e.message));
  await ctx.route('**/*', (r) =>
    r.request().url().startsWith(server.origin) ? r.continue() : r.abort(),
  );
  await page.goto(server.origin + QUESTION, {
    waitUntil: 'domcontentloaded',
    timeout: 30_000,
  });

  await page.getByText(OPTION_TEXT).first().click({ timeout: 20_000 });
  await page.getByRole('button', { name: '提交答案' }).click({ timeout: 10_000 });

  // 挑戰面板只在 revealed 之後才掛載 —— 等它真的出現,否則後面全在點空氣。
  const agree = page.getByRole('button', { name: '同意挑戰' });
  await agree.waitFor({ timeout: 20_000 });
  return { ctx, page, errors, agree };
}

test('按下「同意挑戰」的當下就有 loader,不是等回應回來才有', async (t) => {
  if (skipReason) {
    if (REQUIRE) assert.fail(`E2E_REQUIRE=1 但無法執行:${skipReason}`);
    return t.skip(skipReason);
  }

  const { ctx, page, errors, agree } = await openRevealedQuestion();
  try {
    assert.equal(
      await agree.getAttribute('aria-busy'),
      'false',
      '還沒按就已經是 busy —— 那條斷言之後就分不出有沒有作用了',
    );

    await agree.click();

    // 伺服器壓了 1200ms 才回,所以這段窗裡看得到 spinner 就證明它不是等回應
    // 才出現的。逾時遠短於「按下去到回應回來」以外的任何解釋。
    await page
      .locator('button[aria-busy="true"]', { hasText: '同意挑戰' })
      .waitFor({ timeout: 3_000 });

    assert.equal(
      await page.getByRole('button', { name: '反對' }).isDisabled(),
      true,
      '請求還在飛,反對鍵卻還能按 —— 會送出互相矛盾的兩票',
    );

    // 收尾必須獨立於「伺服器回了什麼」—— 綁上投票結果的話,這條就同時在驗
    // 下面那支測試的機制,而 loader 本身壞掉與否反而分不出來。
    await page
      .locator('button[aria-busy="false"]', { hasText: '同意挑戰' })
      .waitFor({ timeout: 20_000 });
    assert.equal(
      await page.getByRole('button', { name: '反對' }).isDisabled(),
      false,
      '請求早就回來了,反對鍵卻還鎖著 —— pending 沒有清掉',
    );
    assert.deepEqual(errors, [], `投票時有未捕捉例外:\n${errors.join('\n---\n')}`);
  } finally {
    await ctx.close();
  }
});

test('投一票只走一趟往返 —— 投完不再補抓 challenges/active', async (t) => {
  if (skipReason) {
    if (REQUIRE) assert.fail(`E2E_REQUIRE=1 但無法執行:${skipReason}`);
    return t.skip(skipReason);
  }

  const { ctx, page, errors, agree } = await openRevealedQuestion();
  try {
    const activeHits = () => server.apiHits().filter((p) => p === ACTIVE_PATH).length;
    // 掛載時抓過一次 —— 沒有這個基準,「投完是 0 次」在面板從未渲染時也成立。
    assert.ok(activeHits() >= 1, '面板掛載時沒抓過 challenges/active,基準不成立');
    const before = activeHits();

    await agree.click();
    await page.getByRole('button', { name: '撤回投票' }).waitFor({ timeout: 20_000 });
    // 多等一段,把「慢一點才補抓」也涵蓋進來。
    await page.waitForTimeout(API_DELAY_MS * 2);

    assert.equal(
      activeHits(),
      before,
      '投完票又去補抓了 challenges/active —— POST 的回應沒被採用,' +
        '每投一票就要多等兩趟網路',
    );
    assert.deepEqual(errors, [], `投票時有未捕捉例外:\n${errors.join('\n---\n')}`);
  } finally {
    await ctx.close();
  }
});

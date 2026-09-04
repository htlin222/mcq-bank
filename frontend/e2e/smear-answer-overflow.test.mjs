// 抹片練習作答頁的 image_note / 判定後的正解與可接受寫法(GradeReveal)是自由
// 文字欄位,不保證有空白或連字號可斷行 —— 同 CLAUDE.md「檢討介面只有一套」那節
// 的 `DEK::NUP214` 教訓:融合基因這類命名法完全可能沒有天然斷行點,`break-words`
// 沒掛上去的話,一個字就能把整頁往右推出視窗。
//
// 這支是 D3(作答頁)review 時發現的:對抗性測試在 320px 塞進一個真的沒有空白
// /連字號/斜線的長字串(image_note 與 GradeReveal 的 canonical/acceptedTerms),
// scrollWidth 量到明顯超出 clientWidth(629/708 vs 320)。修法是在
// `SmearSession.tsx` 的 image_note 段落與 `GradeReveal.tsx` 的正解/可接受寫法
// chip 上補 `break-words`(chip 另外補 `max-w-full`,因為它是 `flex-wrap` 容器
// 裡的 item)。
//
// 兩個空掃防線:
//   1. 先確認 image_note / 正解文字真的渲染出來了(不是選擇器腐爛)。
//   2. 用的是真的沒有空白的字串(不含連字號/斜線 —— 那些本身就是天然斷行點,
//      用不含它們的字串才是這個 bug 真正的觸發條件)。
//
//   pnpm test:webkit
//
// 沒安裝 playwright / webkit 時預設跳過;CI 設 E2E_REQUIRE=1 改為失敗。

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
  if (REQUIRE) throw new Error(skipReason);
  t.skip(skipReason);
  return true;
}

function overflow(page) {
  return page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
}

test('320px:image_note 沒有空白也不會把頁面撐寬', async (t) => {
  if (guard(t)) return;
  const context = await browser.newContext({ viewport: { width: 320, height: 700 } });
  const page = await context.newPage();
  await page.goto(server.origin + '/smear/s/e2e-3');
  await page.getByPlaceholder('輸入診斷或細胞名稱…').waitFor();
  const note = page.locator('text=imagenotewithnobreakpoints');
  assert.equal(await note.count(), 1, '找不到 image_note —— 選擇器腐爛,這支測試等於沒跑');
  const box = await overflow(page);
  assert.ok(
    box.scrollWidth <= box.clientWidth + 1,
    `image_note 把頁面撐寬了:scrollWidth=${box.scrollWidth} clientWidth=${box.clientWidth}`,
  );
  await context.close();
});

test('320px:判定後的正解/可接受寫法沒有空白也不會把頁面撐寬', async (t) => {
  if (guard(t)) return;
  const context = await browser.newContext({ viewport: { width: 320, height: 700 } });
  const page = await context.newPage();
  await page.goto(server.origin + '/smear/s/e2e-3');
  await page.getByPlaceholder('輸入診斷或細胞名稱…').fill('anything');
  await page.getByRole('button', { name: '提交答案' }).click();
  await page.waitForSelector('[data-testid="grade-reveal"]');
  const canonical = page.locator(
    'text=supercalifragilisticexpialidocioussupercalifragilisticexpialidocioussupercalifragilisticexpialidocious',
  );
  assert.ok((await canonical.count()) >= 1, '找不到正解文字 —— 選擇器腐爛,這支測試等於沒跑');
  const box = await overflow(page);
  assert.ok(
    box.scrollWidth <= box.clientWidth + 1,
    `正解/可接受寫法把頁面撐寬了:scrollWidth=${box.scrollWidth} clientWidth=${box.clientWidth}`,
  );
  await context.close();
});

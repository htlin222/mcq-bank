// 貼上圖片的等待狀態:轉圈停在游標上,不是頂端一條進度條。
//
// 舊版在編輯器頂端畫一條無限捲動的細條。它的問題不是難看,是**位置**:貼上
// 的當下視線在游標,而圖片正要落在游標;抬頭去看一條 2px 的線,等於這段等待
// 沒有被告知。現在改成 ProseMirror 的 widget decoration —— 它跟著文件座標走,
// 編輯器捲動、繼續打字都還黏在插入點上。
//
// 三件事各自都能單獨壞掉,所以分三條斷言,而且**每一條都是正面的**:
//   1. 貼上之前沒有轉圈(對照組:少了它,「有轉圈」可能只是它一直都在)
//   2. 上傳途中,轉圈在**編輯器裡面**,而且**動畫真的在跑**
//      (class 名打錯 / styles.css 那條規則沒對上時,圈會靜止 —— 靜止的
//       轉圈跟當掉分不出來,而 DOM 存在與否驗不到這件事)
//   3. 上傳完成後轉圈收掉,圖片落在原地
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

const LIVE_EDITOR = '.ProseMirror[contenteditable="true"]';
const tab = (page, name) => page.locator('button:visible', { hasText: name }).first();

// 留言輸入框是這個 build 裡最好進的一個可編輯 RichEditor:點一下就有,
// 不必先拿詳解的編輯鎖。貼上走的是 RichEditor 自己的 handlePaste,
// 跟詳解 / 個人筆記是同一份程式。
async function openComposer(page) {
  await page.goto(server.origin + '/q/113-050', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(700);
  const t = tab(page, '討論串');
  assert.equal(await t.count(), 1, '找不到「討論串」分頁');
  await t.click();
  await page.waitForTimeout(350);
  const placeholder = page.locator('[data-comment-composer]:visible');
  assert.equal(await placeholder.count(), 1, '看不到留言輸入的入口');
  await placeholder.click();
  await page.waitForTimeout(350);
  assert.equal(await page.locator(LIVE_EDITOR).count(), 1, '點了輸入框卻沒有出現編輯器');
}

// 從剪貼簿貼一個 PNG 檔進編輯器。回傳事件實際帶了幾個檔案 —— 0 代表這個
// 引擎沒讓我們把檔案塞進 ClipboardEvent,那樣後面所有斷言都不算數。
function pasteImage(page) {
  return page.evaluate(() => {
    const el = document.querySelector('.ProseMirror[contenteditable="true"]');
    el.focus();
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array([137, 80, 78, 71])], 'x.png', { type: 'image/png' }));
    const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
    el.dispatchEvent(ev);
    return ev.clipboardData ? ev.clipboardData.files.length : 0;
  });
}

test('貼上圖片:轉圈停在游標上,上傳完才換成圖片', async (t) => {
  if (guard(t)) return;
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();

  await ctx.route('**/*', (r) =>
    r.request().url().startsWith(server.origin) ? r.continue() : r.abort(),
  );
  // 把上傳這一趟握在手上:不放行,轉圈就一直在,不必跟時間賽跑。
  //
  // ⚠️ 一定要**晚於**上面那條 catch-all 註冊 —— playwright 的 route 是後註冊
  // 的先比對。反過來寫的話 catch-all 會先 continue 出去,樁伺服器對沒有
  // fixture 的端點回 `{}`,於是上傳「瞬間成功」但 url 是 undefined:畫面上
  // 是一個沒有 src 的 <img>,而轉圈快到看不見。實際踩過。
  let release;
  const held = new Promise((r) => (release = r));
  await ctx.route('**/api/upload', async (r) => {
    await held;
    await r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ url: '/img/pasted.png' }),
    });
  });

  try {
    await openComposer(page);

    const spinner = page.locator(`${LIVE_EDITOR} .upload-spinner`);
    assert.equal(await spinner.count(), 0, '還沒貼上就有轉圈了 —— 下面的斷言不算數');

    assert.equal(await pasteImage(page), 1, '這個引擎沒讓 ClipboardEvent 帶檔案,測試沒驗到任何事');
    await page.waitForTimeout(200);

    assert.equal(await spinner.count(), 1, '貼上圖片後,游標上沒有出現轉圈');

    // 轉圈必須真的在轉。class 名跟 styles.css 對不上時 DOM 照樣在,只是不動。
    const running = await page.evaluate(() => {
      const el = document.querySelector('.upload-spinner .upload-spinner-icon');
      return el ? el.getAnimations().length : -1;
    });
    assert.ok(running > 0, `轉圈是靜止的(getAnimations → ${running}),看起來跟當掉一樣`);

    release();
    await page.waitForTimeout(400);

    assert.equal(await spinner.count(), 0, '上傳完了轉圈還留在游標上');
    // 認 src 而不是認 `img` —— ProseMirror 自己會在游標旁塞一個
    // `img.ProseMirror-separator`(空的 alt),數 `img` 會把它一起數進來。
    assert.equal(
      await page.locator(`${LIVE_EDITOR} img[src="/img/pasted.png"]`).count(),
      1,
      '上傳完成卻沒有把圖片插進編輯器',
    );
  } finally {
    await ctx.close();
  }
});

// WebKit 冒煙測試 —— 每條關鍵路徑「渲染得出東西,而且沒有未捕捉例外」。
//
// 為什麼是 WebKit 而不是 Chromium:2026-07-29 之前,所有 iOS 使用者的題目頁
// 都是整頁白屏,而 364 個單元測試全綠、Chromium 上完全正常。成因是
// `useEditor` 會先交出一個已銷毀的 Editor,往它寫入時 ProseMirror 在
// commit 階段丟例外,React 18 直接卸載整棵樹。那是個時序競賽:WebKit 穩定
// 命中、Chromium 量不到。iOS 強制所有瀏覽器使用 WebKit,所以「Chrome 上是
// 好的」對這個 repo 完全不構成證據。
//
// 這支測試的斷言刻意只有兩條 —— 有內容、無 pageerror。它不驗業務邏輯
// (那是單元測試的事),它驗的是「整棵樹還活著」,而那正是單元測試碰不到、
// 卻會讓整個功能對整個平台消失的那一類失敗。
//
// 必須打**正式建置產物**:dev server 的 React StrictMode 雙掛載會製造不同的
// 訊號(額外的 keyed plugin 衝突),掩蓋真正的成因。
//
//   pnpm test:webkit          # 會先 build
//
// 沒安裝 playwright / webkit 時預設跳過;CI 設 E2E_REQUIRE=1 讓它改為失敗,
// 這樣「忘了裝瀏覽器」不會偽裝成「測試通過」。

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(HERE, '..', 'dist');
const REQUIRE = process.env.E2E_REQUIRE === '1';

// 路徑清單刻意小:每一條都代表一種**渲染型態**,而不是一個功能。
// 加新路徑的判準是「它會不會掛載一種別處沒有的元件」。
const ROUTES = [
  { path: '/', name: '首頁' },
  { path: '/year/113', name: '年度列表' },
  {
    path: '/q/113-050',
    name: '題目頁(TipTap 詳解 + 影片 tab)',
    // 題幹出現 = AnnotatableContent 真的掛起來了。只斷言「有內容」的話,
    // 光是 header 就能讓 body 非空,白屏會漏掉。
    expectText: '孟買血型',
  },
  { path: '/videos', name: '影片庫' },
  { path: '/review', name: '複習首頁' },
  {
    path: '/review/new-year',
    name: '加入新年份精靈(輪詢 + 暫存區審閱)',
    // 這條路徑掛的是別處沒有的型態:setInterval 輪詢驅動的多步流程,加上
    // 由伺服器資料長出來的逐題審閱清單。fixture 給的是「已推送、有待確認題」
    // 的狀態,所以第五步的審閱面板會真的被渲染出來,而不是停在提示文字。
    expectText: '待確認',
  },
  {
    path: '/notes/n1',
    name: '其他筆記單則(NoteContent 畫記層 + 關聯建議)',
    // 這頁掛的是 AnnotatableContent 驅動的唯讀筆記 —— 就是 2026-07 iOS
    // 白屏那個 useEditor 競態的溫床。斷言內文而不是標題:標題是純 DOM,
    // 光有它不能證明畫記層真的掛起來了。
    expectText: 'anthracycline',
  },
  {
    path: '/play',
    name: '2048(useReducer + 全域鍵盤/觸控監聽 + debounce timer)',
    // 這頁掛的是別處沒有的型態:reducer 驅動的盤面,加上兩個掛在 window/
    // document 上的事件監聽與一個 debounce timer —— 三者都在卸載時要收乾淨。
    // fixture 給的是「玩到一半」的存檔,所以斷言得到盤面上的磚,而不只是標題。
    expectText: '128',
  },
  {
    path: '/profile',
    name: '個人資料(答題狀態分析:debounce 報數 + 日期輸入)',
    // 這頁掛的是別處沒有的型態:條件一改就重跑的 debounce 請求(帶 seq 防亂序)
    // 加上一組 <input type="date">。斷言「筆」而不只是標題,因為報數要等
    // debounce + fetch 都回來才畫得出來 —— 中途卸載沒收乾淨就會在這裡炸。
    expectText: '801 筆',
  },
  {
    path: '/smear/s/e2e-1',
    name: '抹片練習作答頁(圖片 lightbox portal + 單一自由輸入框)',
    // 這頁掛的是別處沒有的型態:點擊縮圖才掛載的全螢幕 lightbox portal
    // (SmearImage),以及只送一個元素陣列給 /answer 的自由輸入框
    // (AnswerInput)。「點擊放大」是縮圖疊字,證明 SmearImage 真的掛起來了。
    expectText: '點擊放大',
  },
  {
    path: '/smear/dx/dacrocyte',
    name: '抹片診斷詳情(StaticContent 詳解 + 圖片格線 + 提報表單)',
    // 這頁掛的是別處沒有的型態:GET /api/smear/dx/:id 一次餵出詳解 JSON、
    // 已接受寫法、圖片清單與相關診斷四種資料,渲染路徑跟 /smear/s/:id 完全
    // 不同(唯讀 StaticContent,不是 AnswerInput/GradeReveal)。斷言
    // 「dacryocyte」而不是標題:標題是同步可得的 URL 參數渲染,光有它不能
    // 證明 GET 回來的 terms/note/questions 真的餵進元件樹了。
    expectText: 'dacryocyte',
  },
  {
    path: '/smear?tab=search',
    name: '抹片搜尋分頁(獨立索引,debounce 空狀態)',
    // 掛的是別處沒有的型態:race-safe debounce(同 LectureSearchBox 的形狀)
    // 但打的是完全獨立的 /api/smear/search,不是 MCQ 的 /api/search。空查詢
    // 不發請求,直接斷言提示文字,證明這個分頁真的掛起來而不是停在佔位文字。
    expectText: '輸入關鍵字開始搜尋診斷',
  },
  {
    path: '/smear/s/e2e-result/result',
    name: '抹片成績頁(D4:依序打 finish + GET /sessions/:id 再用 question_id 併起來)',
    // 掛的是別處沒有的型態:兩支既有端點依序打完再用 question_id 手動 join
    // (finish 給判定、GET /sessions/:id 給圖片),不是單一端點一次到位。
    // 斷言主題分類的標籤,證明 finish 的 breakdown 真的被分組畫出來,而不是
    // 卡在「載入中…」—— 那正是兩支請求沒接對時最容易出現的樣子。
    expectText: '主題分類',
  },
  {
    path: '/smear?tab=history',
    name: '抹片作答記錄(D4:HistoryTab —— 未完成的全真模式不揭曉分數)',
    // 掛的是別處沒有的型態:同一支列表混著「已完成/未完成」與「複習/全真」
    // 四種組合,而未完成那一列刻意不畫分數區塊(見 Smear.tsx 的 HistoryRow
    // 註解)。斷言「未完成」而不只是標題,證明清單真的抓回 fixture 裡那筆
    // finished_at=null 的全真模式,而不是卡在「載入中…」。
    expectText: '未完成',
  },
  {
    path: '/smear?tab=wrong',
    name: '抹片錯題本(D4:WrongTab —— 按診斷聚合、worst-first)',
    expectText: '次答錯',
  },
  {
    path: '/smear?tab=submit',
    name: '抹片投稿(表單 + 個人投稿紀錄,admin 子分頁另有 eink.test.mjs 涵蓋)',
    // 掛的是別處沒有的型態:multipart 表單(圖片挑選 + 預覽)疊在一支既有清單
    // 上。斷言歷史清單裡的投稿答案文字,證明 GET /submissions/mine 真的餵進
    // 元件樹,而不是卡在「載入中…」。
    expectText: 'dacrocyte',
  },
];

// fixture 是從真實 API 抓下來的，而這個 repo 是公開的 —— 第一版就差點把 18 位
// 成員的 email 提交上去。這條測試不需要瀏覽器，永遠會跑：抓完 fixture 忘了去
// 識別化時，它會在 push 之前擋下來。
test('fixture 不含真實 email（repo 是公開的）', () => {
  const FIXTURES = path.join(HERE, 'fixtures');
  const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
  const leaked = [];
  for (const name of fs.readdirSync(FIXTURES)) {
    if (!name.endsWith('.json')) continue;
    const text = fs.readFileSync(path.join(FIXTURES, name), 'utf8');
    for (const addr of text.match(EMAIL) ?? []) {
      if (!addr.endsWith('@example.com')) leaked.push(`${name}: ${addr}`);
    }
  }
  assert.deepEqual(
    leaked,
    [],
    `fixture 裡有非 @example.com 的 email —— 去識別化後再提交：\n  ${leaked.join('\n  ')}`,
  );
});

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
  if (server) {
    const missing = server.missingFixtures();
    if (missing.length) {
      console.log(`\n[e2e] 用了空回應的端點(要加涵蓋範圍就補 fixture):\n  ${missing.join('\n  ')}`);
    }
    await server.close();
  }
  if (browser) await browser.close();
});

for (const route of ROUTES) {
  test(`WebKit / iPhone:${route.name} ${route.path}`, async (t) => {
    if (skipReason) {
      if (REQUIRE) assert.fail(`E2E_REQUIRE=1 但無法執行:${skipReason}`);
      return t.skip(skipReason);
    }

    const { devices } = await import('playwright');
    const ctx = await browser.newContext(devices['iPhone 13']);
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.stack || e.message));

    // 掐掉所有跨源請求。index.html 會拉 Google Fonts,而 `waitUntil: 'load'`
    // 會等它 —— 在沒有外網的機器上(CI sandbox、飛機上)那就是 30 秒逾時,
    // 而且逾時的樣子跟真的壞掉沒兩樣。測試要能離線重現。
    await ctx.route('**/*', (r) =>
      r.request().url().startsWith(server.origin) ? r.continue() : r.abort(),
    );

    try {
      // domcontentloaded 而不是 load:要等的是 React 掛載,不是最後一張字型。
      await page.goto(server.origin + route.path, {
        waitUntil: 'domcontentloaded',
        timeout: 30_000,
      });
      // 這些頁面都是進來之後才抓資料再渲染,DOM ready 本身太早。
      await page.waitForTimeout(3_000);

      const text = await page.evaluate(() => document.body.innerText);

      assert.equal(
        errors.length,
        0,
        `${route.path} 有未捕捉例外(WebKit):\n${errors.join('\n---\n')}`,
      );
      assert.ok(
        text.trim().length > 0,
        `${route.path} 渲染出空白頁面 —— React 很可能在 commit 階段丟例外後卸載了整棵樹`,
      );
      if (route.expectText) {
        assert.ok(
          text.includes(route.expectText),
          `${route.path} 缺少預期內容「${route.expectText}」;實際開頭:${text.slice(0, 200)}`,
        );
      }
    } finally {
      await ctx.close();
    }
  });
}

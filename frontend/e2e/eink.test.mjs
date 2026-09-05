// 電子紙模式(1-bit)的顏色守門 —— 走訪路由,掃描畫面上每個看得見的元素,
// 斷言它的每個顏色屬性不是全透明,就是 r===g===b 且 ∈ {0,255} 且 alpha===1。
//
// 為什麼是「一條」斷言而不是分成「不可以有彩色」與「不可以有灰」兩條:
// 灰就是 r===g===b 但不在 {0,255};半透明黑疊在白底上算出來也是灰。把
// alpha===1 寫進同一個條件,兩種破口就都被同一條規則抓住。
//
// 這支測試是那層 `[class*=]` 中和層唯一的長期保險。中和層是字串比對,天生
// 構不到 inline style 與第三方元件(EmbedPDF、cal-heatmap、react-animals),
// 而那些破口在 code review 裡看不出來 —— 只有真的把頁面畫出來、量每個像素
// 的來源才會現形。
//
// 走的是**正式建置產物**與假 API,理由同 smoke.test.mjs。
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

// storage key 來自 config.toml,不硬編碼 —— 寫死的話,改了 config 之後這支
// 測試會在「根本沒進到 e-ink 模式」的情況下全綠,而那比紅燈更糟。
function themeStorageKey() {
  const toml = fs.readFileSync(path.join(HERE, '..', '..', 'config.toml'), 'utf8');
  const m = /^\s*theme_storage_key\s*=\s*"([^"]+)"/m.exec(toml);
  assert.ok(m, 'config.toml 找不到 theme_storage_key');
  return m[1];
}

// 使用者上傳的醫學圖片與 PDF 是**內容**,不是介面 —— 血液抹片、免疫染色、
// 流式散點圖的顏色本身就是要學的診斷資訊,刻意豁免(見 styles.css 的說明)。
const SKIP_TAGS = new Set([
  'IMG', 'CANVAS', 'VIDEO', 'PICTURE', 'SOURCE', 'OBJECT', 'EMBED', 'IFRAME',
]);

const ROUTES = [
  { path: '/', name: '首頁(倒數/進度條/熱力圖入口)' },
  { path: '/year/113', name: '年度列表(分類 badge)' },
  { path: '/review', name: '複習首頁' },
  { path: '/videos', name: '影片庫(時長膠囊 bg-black/75)' },
  { path: '/notes/n1', name: '其他筆記(TipTap 唯讀 + 畫記層)' },
  { path: '/play', name: '2048(bg-ink-800 深底淺字磚塊)' },
  {
    path: '/q/113-050',
    name: '題目頁 → 作答 → 揭曉(正解/答錯的配色只在這個瞬間存在)',
    // emerald/rose 只有在「已揭曉」時才上畫面。不做這步互動的話,這頁掃過去
    // 會是綠的,而全站最核心的那組語意色從來沒被檢查過。
    //
    // fixture(questions_113-050.json)的正解是 B —— 這裡刻意點 A,好讓
    // 「✓ 正解」(emerald)與「✗ 你的選擇」(rose)在**同一次掃描**裡都在畫面上。
    // 點對的話 rose 那條路徑永遠不會被檢查到。
    // 選項是 <li> 不是 <button>(整列可點),用 role 找會什麼都點不到而測試照樣
    // 全綠 —— 所以下面 expectAfter 的正面斷言是承重的,不是保險。
    async interact(page) {
      await page.locator('ul > li').filter({ hasText: '先生為孟買血型' }).first().click();
      await page.getByRole('button', { name: '提交答案' }).click();
      await page.waitForTimeout(1_000);
    },
    expectAfter: ['正解', '你的選擇'],
  },
  {
    path: '/q/113-050',
    name: '題目頁 → 詳解分頁(防劇透遮罩)',
    // 必須單獨走一條路由:手機一律走分頁 (#96) 之後,詳解那一欄在「題目」分頁下是
    // display:none,掃描迴圈的 getClientRects() 會整欄跳過 —— 上面那條路由再怎麼
    // 掃都碰不到防劇透遮罩。這正是「模糊成一團灰」能活到使用者手上的原因。
    // 用 /^詳解/ 而不是精確字串:分頁列上「詳解」與內層可能同名,取第一顆(上層)。
    async interact(page) {
      await page.getByRole('button', { name: /^詳解/ }).first().click();
      await page.waitForTimeout(500);
    },
    expectAfter: ['點擊顯示詳解'],
  },
  {
    path: '/exam/e2e-1/result',
    name: '成績頁 → 查看詳解(整個對話框從來沒有被掃過)',
    // 對話框活在 portal 裡,載入任何一條路由都不會讓它自己出現 —— 所以它是
    // **一整塊沒被掃過的畫面**,而它同時是這個站上新的長文閱讀面。半透明的
    // 遮罩(bg-ink-900/40)正是這一層在消滅的那種中間灰,而它在 light/dark
    // 底下完全正常 —— 同「防劇透那團灰能活到使用者手上」的成因。
    //
    // `force: true`:那顆鈕在有指標的裝置上是 opacity-0(hover 才現身),而
    // 掃描用的是桌機視窗。
    async interact(page) {
      await page
        .locator('button[aria-label^="查看第"]')
        .first()
        .click({ force: true });
      await page.waitForSelector('[role="dialog"]', { timeout: 10_000 });
      await page.waitForTimeout(500);
    },
    // fixture(questions_113-001.json)裡的標記字串 —— 用「詳解」兩個字當判準
    // 會恆真,那兩個字在按鈕上本來就有。
    expectAfter: ['凝血因子的鑑別診斷'],
  },
  {
    path: '/wrong',
    name: '錯題回顧 → 展開全部選項(共用的選項區從來沒有被掃過)',
    // `AnswerOptions` 預設是收合的,成績頁那條路由也是 —— 所以「正解=整列反白 /
    // 選錯=粗框+刪除線 / 分布長條改畫成貼底黑槓」這一整組 e-ink 語意,在這條加進來
    // 之前**一次都沒有被掃描到**。掃在這一頁而不是成績頁:那是同一個元件,掃一次
    // 就夠,而這一頁的預設篩選比較不會變。
    async interact(page) {
      await page.getByRole('button', { name: '展開全部選項' }).click();
      await page.waitForTimeout(600);
    },
    // fixture(review_wrong.json)裡的選項全文 —— 用「正解」兩個字當判準會恆真,
    // 收合狀態下按鈕上本來就有字。
    expectAfter: ['✓ 正解', '你選的'],
  },
  {
    path: '/exam/e2e-1',
    name: '作答中 → 交卷確認(整個對話框從來沒有被掃過)',
    // 同上一條:portal 裡的對話框,載入路由不會讓它自己出現。而它是這一頁上
    // 顏色最重的一塊 —— 未答題號、標記題號(amber)、警告圖示,三種語意在
    // 1-bit 下會塌成同一種,所以它需要被掃到。
    //
    // fixture 的 running_since 是 null(暫停中),主畫面換成暫停面板,但計時列
    // 上的交卷鈕照樣在 —— 所以這條不必注入「現在」,而暫停中交卷本來就該可以。
    async interact(page) {
      await page.locator('header button', { hasText: '交卷' }).first().click();
      await page.waitForSelector('[role="dialog"]', { timeout: 10_000 });
      await page.waitForTimeout(500);
    },
    // 兩個字串都只存在於對話框裡(頁面上原本沒有),所以不會恆真。
    expectAfter: ['仍要交卷', '回去作答'],
  },
  {
    path: '/smear/s/e2e-1',
    name: '抹片練習 → 作答後的判定(四層 tier badge,只在這個瞬間存在)',
    // GradeReveal 的四層(✓ full / ◐ half / ~ lay / ✗ miss)全部只在「作答後」
    // 才上畫面 —— 同 /q/:id 那條「emerald/rose 只有揭曉時才存在」的理由,不做
    // 這步互動,這一整組 e-ink 語意就從沒被掃過。fixture(smear_sessions_e2e-1_
    // answer.json)刻意回 half tier + 拼字錯誤 + 三層 acceptedTerms,一次掃到
    // badge 的填色(full 用 bg-accent 撈回黑)、外框(half 實線 / lay 虛線)、
    // 拼字提醒的琥珀色框都在同一次掃描裡。
    async interact(page) {
      await page.getByPlaceholder('輸入診斷或細胞名稱…').fill('pronromoblast');
      await page.getByRole('button', { name: '提交答案' }).click();
      await page.waitForSelector('[data-testid="grade-reveal"]', { timeout: 10_000 });
      await page.waitForTimeout(300);
    },
    // 「正解」「拼字提醒」都只存在於判定結果裡,頁面上原本沒有,不會恆真。
    expectAfter: ['正解', '拼字提醒'],
  },
  {
    path: '/smear/s/e2e-4',
    name: '抹片練習 → 未命中判定(miss 徽章的玫瑰色系,e2e-1 從沒掃過)',
    // e2e-1 的 grade.tier 是 half,acceptedTerms 雖然橫跨 full/half/lay 三層
    // (chipCls 跟對應 badgeCls 同色系),但 miss **不會出現在 acceptedTerms
    // 裡**(TERM_TIER_ORDER 只有 full/half/lay,miss 是型別上不可能的
    // AcceptedTerm.tier)—— 於是 GradeReveal 的玫瑰色系(border-rose-600 /
    // text-rose-700,miss 專屬)在 e2e-1 那支測試裡完全沒被畫出來過。這支補上
    // 那唯一還沒掃過的顏色家族,四層 tier 的視覺處理才算真的全部掃完一輪。
    async interact(page) {
      await page.getByPlaceholder('輸入診斷或細胞名稱…').fill('totally unrelated answer');
      await page.getByRole('button', { name: '提交答案' }).click();
      await page.waitForSelector('[data-testid="grade-reveal"]', { timeout: 10_000 });
      await page.waitForTimeout(300);
    },
    // 「未命中」只存在於判定結果裡,頁面上原本沒有,不會恆真。
    expectAfter: ['未命中'],
  },
  {
    path: '/smear/dx/dacrocyte',
    name: '抹片診斷詳情 → 提報 + 投票(虛線 accent 徽章、投票鈕按下的實心玫瑰色,兩者都只在互動後才存在)',
    // GradeReveal 的 TIER_META 只在「作答結果」裡出現過三種既有配色(填色/實線
    // /虛線),這裡是**同一份 TIER_META 之外**的新組合:提報中的徽章是
    // `border-dashed border-accent text-accent`(虛線 + accent,不是 GradeReveal
    // 的虛線 ink-400)。按下「反對」之後投票鈕變成 `bg-rose-600 text-white` 實心 ——
    // GradeReveal 的 miss 只用 rose 當外框,從沒有實心玫瑰色被畫出來過。
    // fixture(smear_dx_dacrocyte_terms.json / smear_terms_dacrocyte-open-1_
    // votes.json)把提報者設成別人,好讓投票鈕真的渲染出來(對自己的提報不能投票)。
    async interact(page) {
      await page
        .getByPlaceholder('輸入診斷或細胞名稱的另一種寫法…')
        .fill('e-ink-test-term');
      await page.getByRole('button', { name: '送出提報' }).click();
      await page.waitForTimeout(500);
      await page.getByRole('button', { name: /反對/ }).click();
      await page.waitForTimeout(300);
    },
    // 「投票中」「反對」都只在提報成功後才出現,頁面上原本沒有,不會恆真。
    expectAfter: ['投票中', '反對'],
  },
  {
    path: '/smear/dx/dacrocyte',
    name: '抹片診斷詳情 → SmearDxPanel 分頁列 + 討論分頁(已有一則回覆,新元件第一次被掃到)',
    // /smear/dx/:id 從單欄頁面拆成「頭部 + SmearDxPanel」之後,分頁列本身
    // (bg-accent 選中態 / 未選中的 bg-white 邊框)以及討論串(留言輸入框收合態
    // 的灰字提示、Avatar 頭像框、巢狀回覆的 `border-l-2`)都是全新的視覺組合,
    // 從沒被這支測試掃過。fixture(smear_dx_dacrocyte_comments.json)刻意帶一則
    // 根留言 + 一則回覆,不用實際發文互動去湊出這個狀態 —— POST 的回應在這支
    // 測試的假伺服器上沒有 fixture,湊出來的內容會是空殼,反而測不到真的討論串
    // 長什麼樣子。
    async interact(page) {
      await page.getByRole('tab', { name: '討論' }).click();
      await page.waitForTimeout(300);
    },
    // 根留言與回覆的內文都只存在於這個 fixture 裡,不會恆真。
    expectAfter: ['這張圖的淚滴細胞很典型', '這個很難認'],
  },
  {
    path: '/smear/s/e2e-1',
    name: '抹片練習作答頁 → 判定後內嵌的 SmearDxPanel(複習模式專屬的新內嵌區塊)',
    // Task 3 把 SmearDxPanel 嵌進複習模式的判定結果底下 —— 這是它在 GradeReveal
    // 之外第一次出現的地方,而且是「同一頁的下半段還有另一組分頁列」這個新組合
    // (GradeReveal 的 tier badge 在上面兩條已經掃過,這裡真正沒掃過的是它下面
    // 那圈新的分頁列 + 詳解內容)。fixture 的 dx_id 是 pronormoblast
    // (smear_dx_pronormoblast.json),note 內文刻意帶進 expectAfter 判準。
    async interact(page) {
      await page.getByPlaceholder('輸入診斷或細胞名稱…').fill('Pronormoblast');
      await page.getByRole('button', { name: '提交答案' }).click();
      await page.waitForSelector('[data-testid="grade-reveal"]', { timeout: 10_000 });
      await page.getByRole('tab', { name: '詳解' }).waitFor({ timeout: 10_000 });
      await page.waitForTimeout(300);
    },
    // 「紅血球系最早期」只存在於 pronormoblast 的詳解 fixture 裡,頁面上原本
    // 沒有,不會恆真。
    expectAfter: ['紅血球系最早期'],
  },
  {
    path: '/smear/s/e2e-result/result',
    name: '抹片成績頁(主題分類進度條,同 PacingCard 的 bg-accent 填色 + eink:border 軌道,但是新元件的第一次掃描)',
    // GradeReveal 的 tier badge 已經在上面兩條掃過(填色/實線/虛線/玫瑰色系),
    // 這裡真正沒被掃過的是**主題分類的進度條**——沿用 PacingCard 本週目標那條的
    // 視覺語彙(填色 bg-accent 會被中和層撈回實心黑,軌道補 eink:border-black
    // 避免 0% 時被洗白到看不見),但這是它在 `/smear` 這個功能底下第一次出現。
    // 三題資料刻意讓 rbc 主題是 0%(dacrocyte 判定 miss)——0% 的軌道最容易在
    // 中和層失手時整條消失,不是只測有內容的那幾條。
    // 不需要 interact:成績頁一載入就會呼叫 finish + GET /sessions/:id 並直接
    // 畫出主題分類,不像判定結果只在互動後才出現。
    expectAfter: ['主題分類', '骨髓性', '紅血球系'],
  },
  {
    path: '/smear?tab=history',
    name: '抹片作答記錄(D4:「未完成」標籤 + 複習/全真模式 badge,從沒被掃過的分頁)',
    // 這個分頁在 D4 的 smoke/eink 都沒被掛上路由,只加了 fixture ——
    // 加新分頁時要問的是「這一頁有沒有哪一塊從來沒被掃過」(CLAUDE.md
    // 歷屆考題面板那節的教訓),而 fixture 裡本來就混著已完成/未完成、
    // 複習/全真四種組合,不需要另外注入資料就能一次掃到。
    expectAfter: ['未完成', '全真模式', '複習模式'],
  },
];

// 顏色屬性的檢查條件 —— 沒有這些前置判斷會淹沒在偽陽性裡。最大的一個是
// border-color:Tailwind 的 preflight 給**每個元素**都設了 `#e5e7eb`(灰),
// 所以邊框顏色只有在 border-width > 0 時才真的上畫面。
const PROBE = `
function px(v) { return parseFloat(v) || 0; }
function visibleProps(el, cs) {
  const out = [];
  out.push(['color', cs.color]);
  out.push(['background-color', cs.backgroundColor]);
  for (const side of ['Top', 'Right', 'Bottom', 'Left']) {
    if (px(cs['border' + side + 'Width']) > 0 && cs['border' + side + 'Style'] !== 'none') {
      out.push(['border-' + side.toLowerCase(), cs['border' + side + 'Color']]);
    }
  }
  if (cs.outlineStyle !== 'none' && px(cs.outlineWidth) > 0) out.push(['outline', cs.outlineColor]);
  if (cs.textDecorationLine !== 'none') out.push(['text-decoration', cs.textDecorationColor]);
  if (el instanceof SVGElement) {
    out.push(['fill', cs.fill]);
    out.push(['stroke', cs.stroke]);
  }
  // 偽元素不在 getComputedStyle(el) 裡。placeholder 是實際踩到的破口:掃描
  // 全綠,但畫面上的搜尋框提示字是淺褐色的 —— 只有把頁面畫出來看才發現。
  if (el.matches('input, textarea')) {
    const ph = getComputedStyle(el, '::placeholder');
    if (ph && ph.color) out.push(['::placeholder color', ph.color]);
  }
  for (const pseudo of ['::before', '::after']) {
    const p = getComputedStyle(el, pseudo);
    if (p && p.content && p.content !== 'none') {
      out.push([pseudo + ' color', p.color]);
      out.push([pseudo + ' background-color', p.backgroundColor]);
    }
  }
  return out;
}
function cssPath(el) {
  const parts = [];
  for (let n = el; n && n.nodeType === 1 && parts.length < 4; n = n.parentElement) {
    let s = n.tagName.toLowerCase();
    const cls = (n.getAttribute('class') || '').trim().split(/\\s+/).filter(Boolean).slice(0, 3);
    if (cls.length) s += '.' + cls.join('.');
    parts.unshift(s);
  }
  return parts.join(' > ');
}
`;

let browser;
// 焦點外框那幾條專用 —— 見下面的說明:那個破口是 Blink 的 UA stylesheet 行為,
// 拿 WebKit 驗會全綠。
let blink;
let server;
let skipReason = null;
let blinkSkipReason = null;
let THEME_KEY;

before(async () => {
  THEME_KEY = themeStorageKey();
  if (!fs.existsSync(path.join(DIST, 'index.html'))) {
    skipReason = `找不到 ${DIST}/index.html —— 先跑 pnpm --dir frontend build`;
    return;
  }
  let webkit;
  let chromium;
  try {
    ({ webkit, chromium } = await import('playwright'));
  } catch {
    skipReason = '沒有 playwright(pnpm --dir frontend add -D playwright)';
    blinkSkipReason = skipReason;
    return;
  }
  try {
    browser = await webkit.launch();
  } catch (e) {
    skipReason = `WebKit 起不來(pnpm exec playwright install webkit):${e.message.split('\n')[0]}`;
  }
  try {
    blink = await chromium.launch();
  } catch (e) {
    blinkSkipReason = `Chromium 起不來(pnpm exec playwright install chromium):${e.message.split('\n')[0]}`;
  }
  if (skipReason && blinkSkipReason) return;
  server = await startServer({ dist: DIST });
});

after(async () => {
  if (server) await server.close();
  if (browser) await browser.close();
  if (blink) await blink.close();
});

for (const route of ROUTES) {
  test(`e-ink 1-bit:${route.name} ${route.path}`, async (t) => {
    if (skipReason) {
      if (REQUIRE) assert.fail(`E2E_REQUIRE=1 但無法執行:${skipReason}`);
      return t.skip(skipReason);
    }

    const { devices } = await import('playwright');
    const ctx = await browser.newContext(devices['iPhone 13']);
    // 在任何 script 之前寫進 localStorage,lib/theme.ts 的 top-level
    // applyTheme() 才讀得到 —— 晚一步就會以 system 主題渲染完第一幀。
    await ctx.addInitScript((k) => localStorage.setItem(k, 'eink'), THEME_KEY);
    const page = await ctx.newPage();
    await ctx.route('**/*', (r) =>
      r.request().url().startsWith(server.origin) ? r.continue() : r.abort(),
    );

    try {
      await page.goto(server.origin + route.path, {
        waitUntil: 'domcontentloaded',
        timeout: 30_000,
      });
      await page.waitForTimeout(3_000);

      const inEink = await page.evaluate(() =>
        document.documentElement.classList.contains('eink'),
      );
      assert.ok(inEink, '<html> 沒有 eink class —— 主題根本沒切過去,後面的掃描沒有意義');
      const noDark = await page.evaluate(() =>
        !document.documentElement.classList.contains('dark'),
      );
      assert.ok(noDark, 'eink 與 dark 同時掛著 —— 1604 處 dark: utility 會復活並蓋過中和層');

      if (route.interact) await route.interact(page);
      // 先確認互動真的把目標狀態帶上畫面,再去掃顏色。少了這步,一個沒點中的
      // locator 會讓「掃了一個什麼都沒發生的頁面」看起來跟「掃過了、很乾淨」
      // 一模一樣。
      for (const needle of route.expectAfter ?? []) {
        const text = await page.evaluate(() => document.body.innerText);
        assert.ok(
          text.includes(needle),
          `互動後畫面上找不到「${needle}」—— 這次掃描沒有涵蓋到預期的狀態`,
        );
      }

      const bad = await page.evaluate(
        ({ probe, skipTags }) => {
          eval(probe);
          const SKIP = new Set(skipTags);
          const out = [];
          for (const el of document.querySelectorAll('*')) {
            if (SKIP.has(el.tagName)) continue;
            if (!el.getClientRects().length) continue; // display:none / 未上版面
            const cs = getComputedStyle(el);
            if (cs.visibility === 'hidden' || cs.opacity === '0') continue;

            for (const [prop, value] of visibleProps(el, cs)) {
              const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?/.exec(value);
              if (!m) continue; // none / currentColor / url(#…)
              const [r, g, b] = [+m[1], +m[2], +m[3]];
              const a = m[4] === undefined ? 1 : +m[4];
              if (a === 0) continue; // 全透明,不上畫面
              const ok = r === g && g === b && (r === 0 || r === 255) && a === 1;
              if (!ok) out.push({ sel: cssPath(el), prop, value });
            }
            if (cs.transitionProperty !== 'none' && cs.transitionDuration !== '0s') {
              out.push({ sel: cssPath(el), prop: 'transition', value: `${cs.transitionProperty} ${cs.transitionDuration}` });
            }
            if (cs.backgroundImage.includes('gradient')) {
              out.push({ sel: cssPath(el), prop: 'background-image', value: cs.backgroundImage });
            }
            // 模糊在 1-bit 下就是灰:blur 過的黑字疊在白底上,得到的正是整層在
            // 消滅的那種中間灰。中和層原本只關 backdrop-filter,關不到 filter,
            // 於是防劇透的 `blur-md` 一路放行(回報 #95 的「一團灰」)。
            // 上面的 getClientRects()/visibility 判斷會跳過已被藏起來的元素,
            // 所以這條只會抓到**真的畫在畫面上**的模糊。
            if (cs.filter.includes('blur(')) {
              out.push({ sel: cssPath(el), prop: 'filter', value: cs.filter });
            }
            // `outline-none` 是「2px 透明外框」而不是 `outline-style: none`,所以
            // 顏色掃描抓不到它被塗黑 —— 黑色在 1-bit 下完全合法。這條從反面驗:
            // 掛了 outline-none 的元素**本來就不該看得見外框**,看得見就是中和層
            // 誤傷(回報 #95 的「奇怪的長方形 overlay」)。
            const cls = el.getAttribute('class') || '';
            if (
              cls.includes('outline-none') &&
              cs.outlineStyle !== 'none' &&
              px(cs.outlineWidth) > 0 &&
              !/rgba\([^)]*,\s*0\s*\)$/.test(cs.outlineColor)
            ) {
              out.push({ sel: cssPath(el), prop: 'outline-none 卻畫得出來', value: cs.outlineColor });
            }
          }
          return out;
        },
        { probe: PROBE, skipTags: [...SKIP_TAGS] },
      );

      // 同一條 CSS 規則會在幾十個元素上重複命中。去重到「選擇器+屬性+值」,
      // 失敗訊息才讀得出來「要修幾個地方」而不是「命中幾次」。
      const uniq = [...new Map(bad.map((b) => [`${b.sel}|${b.prop}|${b.value}`, b])).values()];
      assert.deepEqual(
        uniq.slice(0, 40).map((b) => `${b.prop}: ${b.value}  ← ${b.sel}`),
        [],
        `${route.path} 有非 1-bit 的顏色(共 ${uniq.length} 處,列出前 40)`,
      );
    } finally {
      await ctx.close();
    }
  });
}

// 焦點外框:上面那套掃描永遠抓不到的一種灰。
//
// 平常 outline-style 是 none,只有 :focus-visible 成立的那一瞬間,UA 才畫出
// 它的預設 focus ring —— Chromium/Android 上是 `outline: auto 1px rgb(16,16,16)`,
// 深灰而且是雙色環。中和層是**靠 class 名選取**的(`[class*="outline-"]`),而
// 上一題/下一題、分頁列、底部導覽、筆記內文的 @題號 連結一個 outline utility
// 都沒帶,所以那圈灰一路放行。e-ink 的殘影再讓它留在畫面上,症狀就是「點過的
// 按鈕莫名有灰框、沒點過的完全正常」—— 跟 tap-highlight 那個坑長得一樣,所以
// 很容易誤以為早就修掉了。
//
// 這支**跑 Chromium,不是 WebKit** —— 整個 e2e 套件為了 iOS 用 WebKit,但這個
// 破口是 Blink 的 UA stylesheet 行為(WebKit 畫的 focus ring 不一樣),而回報的
// 裝置是 BOOX,BOOX 是 Android,跑的就是 Blink。拿 WebKit 驗這條會全綠。
//
// 驗的是正面效果:先斷言「真的量到**看得見的**外框」,再斷言每個都是黑白。
// 「看得見」那三個字是承重的 —— 全站有 30 處 `focus:outline-none`,它們的外框是
// 2px 透明,計進去的話正面斷言必然成立,測試就退化成空掃的綠燈(同
// users_online.json 那個坑)。
const FOCUS_ROUTES = ['/q/113-050', '/notes/n1', '/', '/year/113'];

for (const routePath of FOCUS_ROUTES) {
  test(`e-ink 1-bit:焦點外框(UA 預設 focus ring 是灰的)${routePath}`, async (t) => {
    if (blinkSkipReason) {
      if (REQUIRE) assert.fail(`E2E_REQUIRE=1 但無法執行:${blinkSkipReason}`);
      return t.skip(blinkSkipReason);
    }

    // 不用 iPhone 13 device —— 那會把引擎的觸控啟發式帶進來,而 BOOX 是一台
    // 用實體按鍵/手寫筆操作的 Android 平板。純 viewport 就好。
    const ctx = await blink.newContext({ viewport: { width: 420, height: 900 } });
    await ctx.addInitScript((k) => localStorage.setItem(k, 'eink'), THEME_KEY);
    const page = await ctx.newPage();
    await ctx.route('**/*', (r) =>
      r.request().url().startsWith(server.origin) ? r.continue() : r.abort(),
    );

    try {
      await page.goto(server.origin + routePath, {
        waitUntil: 'domcontentloaded',
        timeout: 30_000,
      });
      await page.waitForTimeout(3_000);

      const bad = [];
      let framed = 0;
      // 鍵盤走訪 —— 用 Tab 而不是 .focus():程式呼叫的 focus 不一定被判定成
      // focus-visible,而 UA 的 focus ring 只在 focus-visible 成立時才畫。
      for (let i = 0; i < 30; i++) {
        await page.keyboard.press('Tab');
        const seen = await page.evaluate(() => {
          const el = document.activeElement;
          if (!el || el === document.body) return null;
          const cs = getComputedStyle(el);
          if (cs.outlineStyle === 'none' || (parseFloat(cs.outlineWidth) || 0) === 0) return null;
          const label = (el.innerText || el.getAttribute('aria-label') || el.tagName).trim().slice(0, 24);
          return { label, color: cs.outlineColor, style: `${cs.outlineStyle} ${cs.outlineWidth}` };
        });
        if (!seen) continue;
        const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?/.exec(seen.color);
        if (!m) continue;
        const [r, g, b] = [+m[1], +m[2], +m[3]];
        const a = m[4] === undefined ? 1 : +m[4];
        if (a === 0) continue; // 透明外框(focus:outline-none,用 ring 表達焦點)
        framed++;
        if (!(r === g && g === b && (r === 0 || r === 255) && a === 1)) {
          bad.push(`${seen.style} ${seen.color}  ← 「${seen.label}」`);
        }
      }

      assert.ok(
        framed > 0,
        `${routePath} 走訪 30 次都沒量到任何**看得見的**焦點外框 —— 這次掃描什麼都沒驗到`,
      );
      assert.deepEqual(
        [...new Set(bad)],
        [],
        `${routePath} 的焦點外框不是 1-bit(共 ${bad.length} 處)`,
      );
    } finally {
      await ctx.close();
    }
  });
}

// 每顆按鈕都要有**不透明**底,否則 BOOX 的瀏覽器會在底下畫自己的底色。
//
// 那塊底色是誰畫的,查了四輪沒收斂(tap-highlight、UA focus ring、原生控制項
// 繪製、accent-color 全部被實機一一否證),而且它結構性地量不到 —— 桌機引擎不畫,
// getComputedStyle 也讀不到。所以這裡驗的不是「底色不見了」,而是**已知有效的
// 那個條件有沒有成立**:
//
//   「複製為 Markdown」在實機上正常,唯一的原因是它剛好帶了 hover:bg-ink-100,
//   於是被中和層通則塗上不透明 #fff,把底下那塊蓋住了。同一列的「收藏」沒有任何
//   bg- class,就露了出來。兩顆都是 <button>,class 只差這一個 token。
//
// `transparent` 不算數(等於沒背景,蓋不住東西),所以斷言要看 alpha === 1。
// 反白區(bg-accent / eink-invert)裡的按鈕本來就該是透明的,排除。
const OPAQUE_BTN_ROUTES = ['/q/113-050', '/', '/year/113', '/notes/n1'];

for (const routePath of OPAQUE_BTN_ROUTES) {
  test(`e-ink 1-bit:按鈕都有不透明底(蓋住瀏覽器自己畫的底色)${routePath}`, async (t) => {
    if (blinkSkipReason) {
      if (REQUIRE) assert.fail(`E2E_REQUIRE=1 但無法執行:${blinkSkipReason}`);
      return t.skip(blinkSkipReason);
    }

    const ctx = await blink.newContext({ viewport: { width: 420, height: 900 } });
    await ctx.addInitScript((k) => localStorage.setItem(k, 'eink'), THEME_KEY);
    const page = await ctx.newPage();
    await ctx.route('**/*', (r) =>
      r.request().url().startsWith(server.origin) ? r.continue() : r.abort(),
    );

    try {
      await page.goto(server.origin + routePath, {
        waitUntil: 'domcontentloaded',
        timeout: 30_000,
      });
      await page.waitForTimeout(3_000);

      const { total, bad } = await page.evaluate(() => {
        const out = [];
        let n = 0;
        const sel = 'button, [type="button"], [type="reset"], [type="submit"]';
        for (const el of document.querySelectorAll(sel)) {
          if (!el.getClientRects().length) continue;
          // 反白區的按鈕該是透明的 —— 給它白底會在黑塊上開一個洞。
          if (el.closest('[class~="bg-accent"], [class*="bg-black"], .eink-invert')) continue;
          n++;
          const bg = getComputedStyle(el).backgroundColor;
          const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?/.exec(bg);
          const alpha = m && m[4] !== undefined ? +m[4] : 1;
          if (!m || alpha !== 1) {
            const label = (el.innerText || el.getAttribute('aria-label') || el.tagName)
              .trim()
              .slice(0, 24);
            out.push(
              `${bg}  ← 「${label}」class="${(el.getAttribute('class') || '').slice(0, 50)}"`,
            );
          }
        }
        return { total: n, bad: out };
      });

      // 正面斷言:真的量到按鈕。少了它,選擇器一腐爛就變成空掃的綠燈。
      assert.ok(total > 0, `${routePath} 一顆看得見的按鈕都沒找到 —— 這次掃描什麼都沒驗到`);
      assert.deepEqual(
        [...new Set(bad)],
        [],
        `${routePath} 有 ${bad.length}/${total} 顆按鈕的底是半透明或全透明,` +
          `蓋不住 BOOX 瀏覽器自己畫的底色`,
      );
    } finally {
      await ctx.close();
    }
  });
}

// 上面那條「每顆按鈕都有不透明底」有一個代價,而它只在 e-ink 出現:焦點環被蓋掉。
//
// 焦點環(ring 是 box-shadow,中和層補的是 outline)畫在**元素自己**那一步,而
// in-flow 的後續兄弟在 tree order 之後才畫背景。展開的手風琴,子標題按鈕正是父
// 標題按鈕的後續兄弟 —— light/dark 下它的背景是透明的所以什麼都沒發生,e-ink 下
// 它帶著一塊實心白,父標題的焦點環下緣就被整條抹掉,只剩 pl-6 縮排露出的一小段。
//
// 這條**只能量像素**:getComputedStyle 讀到的 box-shadow / outline 完全正常,被
// 蓋掉的是繪製結果。所以截圖之後畫回 canvas 數黑點(不必為了解 PNG 加依賴)。
// 斷言是「底邊看得見的黑點數接近元素寬度」,而 topEdge 是對照組 —— 上緣沒有東西
// 蓋得到它,兩邊一起量,選擇器腐爛或截圖對不準時會連對照組一起垮,不會靜靜變綠。
test('e-ink 1-bit:焦點環不被後續兄弟的白底蓋掉(展開的手風琴)', async (t) => {
  if (blinkSkipReason) {
    if (REQUIRE) assert.fail(`E2E_REQUIRE=1 但無法執行:${blinkSkipReason}`);
    return t.skip(blinkSkipReason);
  }

  const ctx = await blink.newContext({ viewport: { width: 900, height: 900 } });
  await ctx.addInitScript((k) => localStorage.setItem(k, 'eink'), THEME_KEY);
  const page = await ctx.newPage();
  await ctx.route('**/*', (r) =>
    r.request().url().startsWith(server.origin) ? r.continue() : r.abort(),
  );

  try {
    await page.goto(server.origin + '/notes/n1', {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });
    await page.waitForTimeout(3_000);

    // fixture 的第一個標題底下**緊接著**就是子標題(中間不隔段落)—— 這是重現的
    // 前提,隔了一段文字,子標題就離焦點環太遠、蓋不到。
    const headings = page.locator('[data-note-heading]');
    assert.ok(
      (await headings.count()) >= 2,
      '/notes/n1 的筆記沒有巢狀標題 —— 這次量的是一顆沒有後續兄弟的按鈕,蓋不到就不算驗過',
    );
    // 手風琴的焦點環用 :focus(不是 :focus-visible),所以程式呼叫 focus() 就夠。
    const btn = headings.first();
    await btn.evaluate((el) => el.focus());
    const box = await btn.boundingBox();
    const shot = await page.screenshot({
      clip: { x: box.x - 6, y: box.y - 6, width: box.width + 12, height: box.height + 12 },
    });

    const edges = await page.evaluate(async (dataUrl) => {
      const img = new Image();
      img.src = dataUrl;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.width;
      c.height = img.height;
      const g = c.getContext('2d');
      g.drawImage(img, 0, 0);
      const d = g.getImageData(0, 0, c.width, c.height).data;
      const rowDark = (y) => {
        let n = 0;
        for (let x = 0; x < c.width; x++) {
          const i = (y * c.width + x) * 4;
          if (d[i] < 128 && d[i + 1] < 128 && d[i + 2] < 128) n++;
        }
        return n;
      };
      // clip 上下各留 6px,環本身 2px —— 取邊界那幾列裡最長的一列。
      const best = (ys) => Math.max(...ys.map(rowDark));
      return {
        width: c.width - 12,
        top: best([4, 5, 6, 7]),
        bottom: best([c.height - 8, c.height - 7, c.height - 6, c.height - 5]),
      };
    }, 'data:image/png;base64,' + shot.toString('base64'));

    assert.ok(
      edges.top >= edges.width * 0.9,
      `焦點環的上緣只量到 ${edges.top}/${edges.width} px —— 對照組就不成立,` +
        `這次量的位置或選擇器不對,底下那條斷言沒有意義`,
    );
    assert.ok(
      edges.bottom >= edges.width * 0.9,
      `焦點環的下緣只剩 ${edges.bottom}/${edges.width} px 看得見(上緣 ${edges.top})—— ` +
        `被後續兄弟的不透明白底蓋掉了,聚焦元素要變成 positioned 才會晚於它們繪製`,
    );
  } finally {
    await ctx.close();
  }
});

// ── 反向守門:亮模式下,e-ink 那層一條都不准生效 ──
//
// 上面所有測試都在 e-ink 底下跑,驗的是「該黑白的有沒有黑白」。它們結構性地
// 看不到反方向的失敗:某條 e-ink 規則漏了 `.eink` 限定,於是在**亮模式**下
// 把東西塗白。那種錯不會報例外、不會被顏色掃描抓到(它只在 e-ink 下跑),
// 使用者看到的只是「怪怪的、有點太亮」—— 而那句話很難對應回任何一行程式。
//
// `frontend/src/lib/einkIsolation.test.ts` 用純文字檢查 styles.css 的每條選擇器;
// 這裡補的是它看不到的那半:**Tailwind 由 `eink:` variant 產生的 utility**
// (`.eink.eink.eink.eink .eink\:border` 之類),那些不在 styles.css 裡,是打包時
// 才生出來的。
//
// 判準是「有沒有命中」,不是「顏色對不對」—— 只要亮模式下沒有任何一條 eink 規則
// 匹配到元素,就不可能被干擾,不必再去比對每個像素。
for (const routePath of ['/', '/year/113', '/q/113-050', '/review']) {
  test(`亮模式不受 e-ink 干擾:沒有任何 eink 規則命中 ${routePath}`, async (t) => {
    if (blinkSkipReason) {
      if (REQUIRE) assert.fail(`E2E_REQUIRE=1 但無法執行:${blinkSkipReason}`);
      return t.skip(blinkSkipReason);
    }

    const ctx = await blink.newContext({ viewport: { width: 1280, height: 900 } });
    // 明確指定亮主題(不是 system)—— system 在深色偏好下會解析成 dark,
    // 那樣測到的是另一件事。
    await ctx.addInitScript((k) => localStorage.setItem(k, 'light'), THEME_KEY);
    const page = await ctx.newPage();
    await ctx.route('**/*', (r) =>
      r.request().url().startsWith(server.origin) ? r.continue() : r.abort(),
    );

    try {
      await page.goto(server.origin + routePath, {
        waitUntil: 'domcontentloaded',
        timeout: 30_000,
      });
      await page.waitForTimeout(3_000);

      // **走一趟 e-ink 再回來**,而不是只驗全新載入的亮模式。使用者的實際路徑就是
      // 這樣(尤其是在調 e-ink 的那幾天),而「切回來時 class 沒被移除」是這一層
      // 唯一防得到、靜態檢查看不到的失敗模式。ORDER 是 light→dark→eink→system,
      // 所以按四下正好繞一圈回到亮模式。
      const toggle = page.getByRole('button', { name: /切換主題/ });
      await toggle.waitFor({ timeout: 10_000 });
      await toggle.click();
      await toggle.click();
      await page.waitForTimeout(600);

      // 正面斷言:真的經過了 e-ink。少了它,循環順序一改(或按鈕沒點到)就變成
      // 「只驗了全新載入的亮模式」,而那本來就會過。
      const wentThroughEink = await page.evaluate(() =>
        document.documentElement.classList.contains('eink'),
      );
      assert.ok(
        wentThroughEink,
        '按兩下之後沒有進到 e-ink —— 這次沒走到切換路徑,後面的檢查等於沒做',
      );

      await toggle.click();
      await toggle.click();
      await page.waitForTimeout(800);

      const rootClass = await page.evaluate(() => document.documentElement.className);
      assert.ok(
        !rootClass.includes('eink'),
        `繞回亮模式後 <html class="${rootClass}"> 還掛著 eink —— 切換沒把它移除,` +
          `整層 1-bit 覆寫會留在亮模式上`,
      );

      const { einkRules, hits } = await page.evaluate(() => {
        const rules = [];
        const hit = [];
        // ⚠️ 不能用 `if (r.cssRules)` 判斷「這是不是群組規則」。支援 CSS Nesting
        // 的引擎(Chromium 就是)給**每一條** CSSStyleRule 都掛了 `cssRules`,值是
        // 空的 CSSRuleList —— 空歸空,它是 truthy。照那樣寫會把所有普通規則都當成
        // 群組、遞迴進空清單然後跳過,結果一條都收不到,而正面斷言以外看不出來。
        const walk = (rs) => {
          for (const r of rs) {
            if (r.cssRules && r.cssRules.length) walk(r.cssRules);
            if (!r.selectorText || !r.selectorText.includes('eink')) continue;
            rules.push(r.selectorText);
            let matched = null;
            try {
              matched = document.querySelector(r.selectorText);
            } catch {
              continue; // ::selection 之類,querySelector 不吃
            }
            if (matched) {
              hit.push(
                r.selectorText.slice(0, 90) +
                  '  ← 命中 <' + matched.tagName.toLowerCase() +
                  ' class="' + (matched.getAttribute('class') || '').slice(0, 50) + '">',
              );
            }
          }
        };
        for (const sheet of document.styleSheets) {
          try { walk(sheet.cssRules); } catch { /* 跨網域樣式表 */ }
        }
        return { einkRules: rules.length, hits: hit };
      });

      // 正面斷言:真的看到 e-ink 規則。CSS 沒載到、或選擇器命名改了的話,
      // 下面那條會在什麼都沒檢查的情況下通過。
      assert.ok(
        einkRules > 20,
        `只找到 ${einkRules} 條 eink 規則,遠少於預期 —— 這次檢查沒有涵蓋到那一層`,
      );
      assert.deepEqual(
        [...new Set(hits)],
        [],
        `亮模式下有 ${hits.length} 條 e-ink 規則命中了元素 —— 那一層漏出來了`,
      );
    } finally {
      await ctx.close();
    }
  });
}

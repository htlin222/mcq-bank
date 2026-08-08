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
let server;
let skipReason = null;
let THEME_KEY;

before(async () => {
  THEME_KEY = themeStorageKey();
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

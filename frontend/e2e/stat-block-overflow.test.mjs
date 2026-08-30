// 首頁三格統計(總題數 / 已複習 / 準確率)在窄螢幕不會把數字擠出格子。
//
// 回報的畫面是「已複習 50746%」「準確率 59%313/530」—— 值與它後面那個小字
// (sub)原本併排在同一行,而 <lg 是三欄格線,一格只有 88–119px。實測 313/530
// 在 320px 超出格子 33px、360px 19px、390px 9px。
//
// 這支跟 overflow.test.mjs 是兩件事,不能互相取代:那支只認**頁面層級**的水平
// 捲動,而這裡溢出的是卡片邊界 —— 字跑出格線但沒有跑出視窗,頁面照樣沒有捲軸。
//
// 寬度繞著斷點兩側取樣(639/640、1023/1024):sub 在 lg 起回到同一行,只測窄的
// 話「永遠換行」也會全綠。
//
// 真實數字由測試在請求當下注入 —— fixture 的 review/stats 是 4 題 1/4,那組數字
// 在任何寬度都塞得下,拿它量等於量不到東西。
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

// 回報當下的真實數字:已複習 507(46%)、準確率 59%(313/530)。
const STATS = {
  questions_attempted: 507,
  total_correct: 313,
  total_attempts: 530,
  by_year: [],
};

const WIDTHS = [320, 360, 390, 639, 640, 1023, 1024];

// 每一格量「子元素有沒有超出這一格的內容框」。回傳格子數是刻意的:選擇器腐爛時
// 它會變成 0,那個 0 讓「沒有溢出」這句話失去話語權。
const PROBE = `
  (() => {
    const labels = ['總題數', '已複習', '準確率'];
    const cells = [];
    for (const el of document.querySelectorAll('div')) {
      const t = (el.firstElementChild?.textContent || '').trim();
      if (!labels.includes(t)) continue;
      if (!el.getClientRects().length) continue;
      const box = el.getBoundingClientRect();
      let over = 0, who = '';
      for (const kid of el.querySelectorAll('*')) {
        const k = kid.getBoundingClientRect();
        const d = Math.max(k.right - box.right, box.left - k.left);
        if (d > over) { over = d; who = kid.textContent.trim().slice(0, 20); }
      }
      cells.push({ label: t, over: Math.round(over), who });
    }
    return {
      cells,
      // sub 真的畫出來了才算數 —— 整段被拿掉時「沒有溢出」也會成立。
      subs: [...document.querySelectorAll('span')]
        .filter((el) => el.textContent.trim() === '313/530').length,
    };
  })()
`;

let browser;
let server;
let skipReason = null;
let THEME_KEY;

before(async () => {
  const toml = fs.readFileSync(path.join(HERE, '..', '..', 'config.toml'), 'utf8');
  const m = /^\s*theme_storage_key\s*=\s*"([^"]+)"/m.exec(toml);
  assert.ok(m, 'config.toml 找不到 theme_storage_key');
  THEME_KEY = m[1];

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

for (const width of WIDTHS) {
  test(`統計數字不溢出格子:${width}px`, async (t) => {
    if (skipReason) {
      if (REQUIRE) assert.fail(`E2E_REQUIRE=1 但無法執行:${skipReason}`);
      return t.skip(skipReason);
    }

    const ctx = await browser.newContext({ viewport: { width, height: 900 } });
    await ctx.addInitScript((k) => localStorage.setItem(k, 'light'), THEME_KEY);
    const page = await ctx.newPage();
    await ctx.route('**/*', (r) => {
      const u = r.request().url();
      if (u.includes('/api/review/stats')) {
        return r.fulfill({ contentType: 'application/json', body: JSON.stringify(STATS) });
      }
      return u.startsWith(server.origin) ? r.continue() : r.abort();
    });

    try {
      await page.goto(server.origin + '/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await page.waitForTimeout(600);
      const r = await page.evaluate(PROBE);

      assert.equal(r.cells.length, 3, `找不到三格統計(量到 ${r.cells.length} 格)`);
      assert.ok(r.subs > 0, '準確率的 313/530 沒有畫出來 —— 溢出斷言會變成空掃');
      const bad = r.cells.filter((c) => c.over > 1);
      assert.deepEqual(bad, [], `${width}px 有數字被擠出格子`);
    } finally {
      await ctx.close();
    }
  });
}

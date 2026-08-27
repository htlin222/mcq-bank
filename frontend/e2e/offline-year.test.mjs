// 進年份頁時在背景把那一年拓進 SW 快取,好讓之後離線也讀得到。
// 設計:docs/plans/2026-08-27-offline-year-prefetch-design.md
//
// ⚠️ **這是整個套件裡唯一讓 Service Worker 真的上線的測試。** 其餘每一支都是
// `serviceWorkers: 'block'`(讓 SW 插手快取會把那些測試的請求數變得不可預測)。
// 這裡不能 block —— 要驗的東西就是 SW 有沒有收下那些 payload。
//
// 兩個踩過的坑,改這支之前先讀:
//
//   ① **離線不要用 `page.goto()`。** WebKit 在 `setOffline(true)` 之下對整頁導覽
//      會丟 "WebKit encountered an internal error",而畫面停在原地 —— 於是
//      「拓過的」與「沒拓過的」看起來一模一樣,兩邊都沒真的導覽過,那組對照
//      什麼都沒證明。用 app 內部的 SPA 導覽,那也才是真實情境(人已經在 app 裡
//      才離線)。
//   ② **對照組要挑真的有 fixture 的題號。** 沒有 fixture 的端點,伺服器回的是
//      `{}` —— 拿它當「拓過的」目標,測試會紅在一個跟功能無關的地方。年份 113
//      的清單有 50 題,但只有 113-050 有真 fixture。
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

/** 有真 fixture 的題號 —— 離線讀得到的那一題必須是它。 */
const REAL = '113-050';
/** 不屬於 113 年,所以不會被預拓 —— 對照組。 */
const NOT_PREFETCHED = '114-001';

let browser;
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
});

after(async () => {
  if (browser) await browser.close();
});

function guard(t) {
  if (!skipReason) return false;
  if (REQUIRE) assert.fail(`E2E_REQUIRE=1 但無法執行:${skipReason}`);
  t.skip(skipReason);
  return true;
}

/** 記錄預抓請求,並量同時在飛的峰值。 */
function watch(page) {
  const seen = [];
  let inFlight = 0;
  let peak = 0;
  const isPrefetch = (u) => /\/api\/questions\/\d{3}-\d{3}(\?|$)/.test(u);
  page.on('request', (r) => {
    if (!isPrefetch(r.url())) return;
    seen.push(r.url());
    inFlight++;
    peak = Math.max(peak, inFlight);
  });
  const done = (r) => {
    if (isPrefetch(r.url())) inFlight--;
  };
  page.on('requestfinished', done);
  page.on('requestfailed', done);
  return {
    get count() {
      return seen.length;
    },
    get peak() {
      return peak;
    },
  };
}

test('SW 還沒接管時一趟都不拓 —— 沒有人會收下那些回應', async (t) => {
  if (guard(t)) return;
  const server = await startServer({ dist: DIST });
  const ctx = await browser.newContext({ viewport: { width: 900, height: 800 } });
  const page = await ctx.newPage();
  const w = watch(page);
  try {
    await page.goto(server.origin + '/year/113', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);

    // 正面對照:頁面真的載出來了。少了這條,「沒有預抓請求」在頁面整個壞掉時
    // 也會成立。
    const n = await page.evaluate(
      () => document.querySelectorAll('a[href^="/q/113-"]').length,
    );
    assert.ok(n > 0, `年份清單該有題目連結,實際 ${n}`);

    assert.equal(
      await page.evaluate(() => !!navigator.serviceWorker?.controller),
      false,
      '第一次造訪 SW 還沒 claim',
    );
    assert.equal(w.count, 0, `第一次造訪不該預抓,實際發了 ${w.count} 趟`);
  } finally {
    await ctx.close();
    await server.close();
  }
});

test('SW 接管之後才拓,而且同時在飛的不超過 4 個', async (t) => {
  if (guard(t)) return;
  const server = await startServer({ dist: DIST });
  const ctx = await browser.newContext({ viewport: { width: 900, height: 800 } });
  const page = await ctx.newPage();
  try {
    // 第一趟只為了讓 SW 裝好;預抓的計數從第二趟才開始。
    await page.goto(server.origin + '/year/113', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);

    const w = watch(page);
    await page.goto(server.origin + '/year/113', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(7000);

    assert.equal(
      await page.evaluate(() => !!navigator.serviceWorker?.controller),
      true,
      '第二次造訪 SW 該接管了',
    );
    const total = await page.evaluate(
      () => document.querySelectorAll('a[href^="/q/113-"]').length,
    );
    assert.ok(w.count >= total, `該把整年拓完(${total} 題),實際 ${w.count} 趟`);
    assert.ok(w.peak <= 4, `同時在飛最多 4 個,實際峰值 ${w.peak}`);
    assert.ok(w.peak > 1, `該是並行的,實際峰值 ${w.peak}`);

    // 拓完之後畫面上要說得出「可以離線了」—— 自動且無聲的話,使用者不知道
    // 現在能不能離線,而那正是他要這個功能的唯一原因。
    await page.waitForFunction(() => /✓ 可離線閱讀/.test(document.body.innerText), {
      timeout: 8000,
    });
  } finally {
    await ctx.close();
    await server.close();
  }
});

test('拓過的題目離線讀得到,沒拓過的讀不到', async (t) => {
  if (guard(t)) return;
  const server = await startServer({ dist: DIST });
  const ctx = await browser.newContext({ viewport: { width: 900, height: 800 } });
  const page = await ctx.newPage();
  try {
    await page.goto(server.origin + '/year/113', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);
    await page.goto(server.origin + '/year/113', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => /✓ 可離線閱讀/.test(document.body.innerText), {
      timeout: 12000,
    });

    // **把 fixture 伺服器關掉**,不是 setOffline —— 真的連不上,而且不會踩到
    // WebKit 對離線整頁導覽的內部錯誤。
    await server.close();

    // 拓過的:用 app 內部導覽(見檔頭的坑 ①)。
    await page.locator(`a[href="/q/${REAL}"]`).first().click();
    await page.waitForTimeout(3000);
    const ok = await page.evaluate(() => ({
      url: location.pathname,
      text: document.body.innerText.replace(/\s+/g, ' '),
    }));
    assert.equal(ok.url, `/q/${REAL}`, '該導覽到那一題');
    assert.ok(
      !/Load failed|載入失敗/.test(ok.text),
      `拓過的題目離線該讀得到,實際:${ok.text.slice(0, 120)}`,
    );

    // 對照組:沒拓過的年份,同樣操作該讀不到。少了它,上面那條在「其實還連得上
    // 網路」時也會成立。
    await page.evaluate((id) => {
      history.pushState({}, '', `/q/${id}`);
      window.dispatchEvent(new PopStateEvent('popstate'));
    }, NOT_PREFETCHED);
    await page.waitForTimeout(3000);
    const miss = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' '));
    assert.ok(
      /Load failed|載入失敗|錯誤/.test(miss),
      `沒拓過的題目離線該讀不到(否則上一條沒有話語權),實際:${miss.slice(0, 120)}`,
    );
  } finally {
    await ctx.close();
    await server.close().catch(() => {});
  }
});

test('圖片:算得出張數、按下去才拓,而且真的進得了 img-v1', async (t) => {
  if (guard(t)) return;
  const server = await startServer({ dist: DIST });
  const ctx = await browser.newContext({ viewport: { width: 900, height: 900 } });
  const page = await ctx.newPage();
  try {
    await page.goto(server.origin + '/year/113', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);
    await page.goto(server.origin + '/year/113', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => /✓ 可離線閱讀/.test(document.body.innerText), {
      timeout: 12000,
    });

    // 文字拓完之前不該出現這顆按鈕 —— 那時快取裡只有一半的 payload,算出來的
    // 張數會偏低,而按鈕上那個數字正是使用者用來決定要不要按的依據。
    const btn = page.locator('button', { hasText: '連圖片一起離線備用' });
    await btn.waitFor({ timeout: 8000 });

    // 正面對照:按鈕上真的寫著張數與 MB,不是一句空話。
    const label = (await btn.innerText()).trim();
    assert.match(label, /約 \d+ 張/, `按鈕該寫出張數,實際:${label}`);
    assert.match(label, /約 [\d.]+ MB/, `按鈕該寫出 MB,實際:${label}`);

    // 按之前:img 快取是空的(或至少不含詳解那張)。這條讓下面的 +N 有話語權。
    const before = await page.evaluate(async () => {
      const c = await caches.open('img-v1');
      return (await c.keys()).length;
    });

    await btn.click();
    await page.waitForFunction(() => /✓ 圖片也備好了/.test(document.body.innerText), {
      timeout: 15000,
    });

    const after = await page.evaluate(async () => {
      const c = await caches.open('img-v1');
      return (await c.keys()).length;
    });
    // ⚠️ 這條守的是一個真的 bug:`/img/*` 原本跟 API 共用 guard,而那支要求
    // content-type 是 application/json,於是**一張都沒進去過**,連 img-v1 那個
    // cache 都不存在。只驗「畫面說備好了」是抓不到的。
    assert.ok(after > before, `圖片該真的進得了 img-v1(${before} → ${after})`);
  } finally {
    await ctx.close();
    await server.close();
  }
});

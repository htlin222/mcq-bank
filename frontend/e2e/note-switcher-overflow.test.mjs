// 個人筆記切換器的 `<往左> <選單> <往右>` 這一組(#193 之後的回報)。
//
// 中間那顆觸發鈕原本寫的是 `max-w-full` —— 那是「最多跟**整個容器**一樣寬」,
// 而容器裡除了它還有左右兩顆跳頁鈕。標題一長,它就真的長到 100%,把「下一則
// 筆記」整顆擠到容器外面。
//
// `max-w-full` 治不了這個形狀,因為它管的是上界不是收縮:flex item 的
// `min-width` 預設是 `auto`(= 內容寬),所以那顆按鈕**根本不肯縮**。要的是
// `min-w-0`,讓它縮到剩下的空間、由裡面的 `truncate` 去截字。
//
// 兩個空掃防線,少了任何一個這支都會退化成恆真:
//   1. 先斷言兩顆跳頁鈕都在(只有一則筆記時它們不出現)。
//   2. 先斷言標題真的被截斷了(`scrollWidth > clientWidth`)—— 標題不夠長的話,
//      「沒有溢出」本來就會成立,量不到任何東西。
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

// 三則筆記、標題都很長 —— 這樣停在中間那則時,左右兩顆跳頁鈕都會出現。
// fixture 只有兩則而且標題是別支測試在用的素材,所以形狀由測試注入(同
// exam-timer-bar 對 running_since 的作法),不改 fixture。
const LONG = '骨髓增生性腫瘤的分子分型與預後分層在臨床上的實際應用與判讀要點';
function payloadWithThreeNotes() {
  const base = JSON.parse(
    fs.readFileSync(path.join(HERE, 'fixtures', 'questions_113-050.json'), 'utf8'),
  );
  const note = (slot, prefix) => ({
    slot,
    content_json: JSON.stringify({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: prefix + LONG }] }],
    }),
    created_at: 1,
    updated_at: 1,
  });
  return {
    ...base,
    my_notes: [note(0, '一'), note(1, '二'), note(2, '三')],
    my_note: { content_json: note(0, '一').content_json, updated_at: 1 },
  };
}

async function openNoteTab(page, width) {
  if (width < 768) {
    const t = page.locator('button:visible', { hasText: '詳解' }).first();
    if (await t.count()) await t.click().catch(() => {});
    await page.waitForTimeout(200);
  }
  const note = page.locator('button:visible', { hasText: '個人筆記' }).first();
  assert.equal(await note.count(), 1, '找不到「個人筆記」分頁');
  await note.click();
  await page.waitForTimeout(400);
}

// 停在中間那則,左右兩顆才會同時存在。用 evaluate 點,因為出事的時候
// 「下一則筆記」正好被擠到容器外,不見得點得到 —— 測試不該被 bug 本身擋住。
async function stepToMiddle(page) {
  await page.evaluate(() => {
    document.querySelector('button[aria-label="下一則筆記"]')?.click();
  });
  await page.waitForTimeout(300);
}

function measure(page) {
  return page.evaluate(() => {
    const next = document.querySelector('button[aria-label="下一則筆記"]');
    const prev = document.querySelector('button[aria-label="上一則筆記"]');
    if (!next || !prev) return { found: false };
    const root = next.parentElement;              // NoteSwitcher 的根 div
    const wrap = root.parentElement;              // 工具列裡包住它的那格
    const label = root.querySelector('span.truncate');
    const r = (el) => {
      const b = el.getBoundingClientRect();
      return { left: b.left, right: b.right, width: b.width };
    };
    return {
      found: true,
      next: r(next),
      prev: r(prev),
      root: r(root),
      wrap: r(wrap),
      truncated: label ? label.scrollWidth > label.clientWidth + 1 : false,
    };
  });
}

for (const width of [390, 768, 1024]) {
  test(`筆記切換器:${width}px 下「下一則」不會被選單擠出容器`, async (t) => {
    if (guard(t)) return;

    const ctx = await browser.newContext({
      viewport: { width, height: 900 },
      ...(width < 768 ? { isMobile: true, hasTouch: true } : {}),
    });
    const page = await ctx.newPage();
    const payload = payloadWithThreeNotes();
    await ctx.route('**/*', (r) => {
      const url = r.request().url();
      if (!url.startsWith(server.origin)) return r.abort();
      if (/\/api\/questions\/113-050$/.test(url)) {
        return r.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(payload),
        });
      }
      return r.continue();
    });

    try {
      await page.goto(server.origin + '/q/113-050', {
        waitUntil: 'domcontentloaded',
        timeout: 30_000,
      });
      await page.waitForTimeout(700);
      await openNoteTab(page, width);
      await stepToMiddle(page);

      const m = await measure(page);
      assert.ok(m.found, '找不到左右兩顆跳頁鈕 —— 沒有停在中間那則筆記上');
      assert.ok(
        m.truncated,
        '標題沒有被截斷,代表它還沒長到會擠壓版面 —— 這條斷言量不到東西',
      );

      assert.ok(
        m.next.right <= m.root.right + 1,
        `「下一則筆記」被擠出切換器 ${(m.next.right - m.root.right).toFixed(1)}px`,
      );
      assert.ok(
        m.root.right <= m.wrap.right + 1,
        `切換器本身溢出了外層 ${(m.root.right - m.wrap.right).toFixed(1)}px`,
      );
      assert.ok(
        m.next.width > 0 && m.prev.width > 0,
        '跳頁鈕被壓成 0 寬 —— 那跟被擠出去一樣不能用',
      );
    } finally {
      await ctx.close();
    }
  });
}

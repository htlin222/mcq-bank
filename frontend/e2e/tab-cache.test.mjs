// 題目頁三塊內容(詳解 / 個人筆記 / 討論串)的載入行為(#150)。
//
// 修的是「切到哪一頁都要等一下」,而成因有兩個,解法完全不同:
//
//   • **網路** —— 討論串每次掛載都重抓。量到的是:進任何一題就先抓一次
//     (那份給窄版面的重複區塊自 #96 起已經永遠隱形,卻照樣掛載),接著每切到
//     討論串分頁再抓一次。同一題來回三圈 = 四次請求,中間沒有人發言。
//   • **主執行緒** —— 分頁切走就把整棵子樹卸掉,切回來要重建 ProseMirror。
//     tiptap 的 `immediatelyRender` 預設 true,所以那是**同步發生在 render
//     phase**的工作:桌機量到 22–31ms,手機約三到五倍。
//
// 三條都是**正面**斷言(先確認東西找得到,再確認行為),而不是「某個副作用沒
// 發生」—— 後者在功能根本沒接上時也會綠。停用 KeepAlive 重建過一次確認會紅。
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

// 分頁按鈕一律挑**看得見**的那顆:切走的分頁還掛在 DOM 裡(KeepAlive),
// `.first()` 會拿到隱形的那個。
const tab = (page, name) => page.locator('button:visible', { hasText: name }).first();

async function clickTab(page, name) {
  const b = tab(page, name);
  assert.equal(await b.count(), 1, `找不到分頁「${name}」`);
  await b.click();
  await page.waitForTimeout(250);
}

async function open(page, { comments = null } = {}) {
  await page.goto(server.origin + '/q/113-050', {
    waitUntil: 'domcontentloaded',
    timeout: 30_000,
  });
  await page.waitForTimeout(700);
}

test('沒有留言的題目,討論串一次都不抓', async (t) => {
  if (guard(t)) return;

  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  let hits = 0;
  await ctx.route('**/*', (r) => {
    if (/\/comments(\?|$)/.test(r.request().url())) hits++;
    return r.request().url().startsWith(server.origin) ? r.continue() : r.abort();
  });

  try {
    await open(page);
    // 空掃防線:先證明分頁真的打得開,否則「0 次請求」只是因為沒點到。
    await clickTab(page, '討論串');
    assert.match(
      await page.locator('body').innerText(),
      /還沒有討論/,
      '沒有停在討論串分頁上 —— 下面那條「0 次」不算數',
    );
    // fixture 的 comment_count 是 0,題目 payload 已經回答了「有沒有留言」。
    assert.equal(hits, 0, `討論串被抓了 ${hits} 次,而這題根本沒有留言`);
  } finally {
    await ctx.close();
  }
});

test('有留言時,來回切分頁只抓一次', async (t) => {
  if (guard(t)) return;

  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();

  // fixture 是好幾支測試共用的素材,不改它 —— 這一題要的只是「comment_count > 0」
  // 這個形狀,由測試在請求當下注入(同 exam-timer-bar 對 running_since 的作法)。
  const payload = JSON.parse(
    fs.readFileSync(path.join(HERE, 'fixtures', 'questions_113-050.json'), 'utf8'),
  );
  const comments = [
    {
      id: 'c1',
      question_id: '113-050',
      parent_id: null,
      author_email: 'a@b.c',
      display_name: '某人',
      avatar_key: null,
      content_json: JSON.stringify({
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: '這是一則留言標記' }] }],
      }),
      created_at: 1,
      helpful_count: 0,
      voted_by_me: 0,
      adopted: 0,
    },
  ];
  let hits = 0;
  await ctx.route('**/*', (r) => {
    const url = r.request().url();
    if (!url.startsWith(server.origin)) return r.abort();
    if (/\/api\/questions\/113-050$/.test(url)) {
      return r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ...payload, comment_count: comments.length }),
      });
    }
    if (/\/api\/questions\/113-050\/comments$/.test(url)) {
      hits++;
      return r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(comments),
      });
    }
    return r.continue();
  });

  try {
    await open(page);
    for (const round of [1, 2, 3]) {
      await clickTab(page, '討論串');
      assert.match(
        await page.locator('body').innerText(),
        /這是一則留言標記/,
        `第 ${round} 圈:討論串沒有畫出留言`,
      );
      await clickTab(page, '個人筆記');
      await clickTab(page, '詳解');
    }
    assert.equal(hits, 1, `來回三圈抓了 ${hits} 次留言,快取沒生效`);
  } finally {
    await ctx.close();
  }
});

test('切走再切回來,詳解與筆記的編輯器沒有被重建', async (t) => {
  if (guard(t)) return;

  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await ctx.route('**/*', (r) =>
    r.request().url().startsWith(server.origin) ? r.continue() : r.abort(),
  );

  // 在看得見的編輯器上蓋一個記號。React 重掛會產生新的 DOM 節點,記號就沒了 ——
  // 所以「記號還在」等於「這棵子樹從頭到尾沒有被卸載過」。
  const stamp = (mark) =>
    page.evaluate((m) => {
      const els = [...document.querySelectorAll('.ProseMirror')].filter(
        (e) => e.getClientRects().length,
      );
      els.forEach((e) => e.setAttribute('data-e2e-stamp', m));
      return els.length;
    }, mark);
  const stamped = (mark) =>
    page.evaluate(
      (m) =>
        [...document.querySelectorAll(`.ProseMirror[data-e2e-stamp="${m}"]`)].filter(
          (e) => e.getClientRects().length,
        ).length,
      mark,
    );

  try {
    await open(page);

    await clickTab(page, '詳解');
    assert.ok((await stamp('exp')) > 0, '詳解分頁上找不到編輯器 —— 記號蓋不上去');

    await clickTab(page, '個人筆記');
    // fixture 那則筆記整份都在標題底下,而收合的區段不渲染子節點 —— 先展開,
    // 否則這一頁一個編輯器都沒有,記號蓋不上去。展開狀態本身也是這條要驗的東西:
    // 分頁被卸載的話,手風琴會一起退回收合。
    for (const h of await page.locator('[data-note-heading]:visible').all()) {
      await h.click().catch(() => {});
    }
    await page.waitForTimeout(250);
    assert.ok((await stamp('note')) > 0, '個人筆記分頁上找不到編輯器');

    await clickTab(page, '詳解');
    assert.ok(
      (await stamped('exp')) > 0,
      '切回詳解時編輯器被重建了 —— 那正是換分頁卡住的那幾十毫秒',
    );

    await clickTab(page, '個人筆記');
    assert.ok((await stamped('note')) > 0, '切回個人筆記時編輯器被重建了');
  } finally {
    await ctx.close();
  }
});

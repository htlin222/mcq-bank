// 討論串的留言輸入框:要看討論的人不該先付一個編輯器的錢。
//
// 量到的(Chromium,CPU 節流 6x ≈ 中階手機):第一次點開「討論串」要 66.7ms,
// 而 fixture 那一題**一則留言都沒有** —— 那個時間全部來自 `NewCommentBox` 自己。
// 它是一個可編輯的 TipTap,一掛載就同步建 EditorView(建 schema、實例化 15 個
// extension、掛 plugin)。多數人開討論串是為了「看」,不是為了「寫」。
//
// 這支守的是三件事,而第一件必須有第三件當對照才有意義:**「沒有編輯器」這種
// 負面斷言,在功能整個壞掉時也會成立**(見 CLAUDE.md 手把那節的教訓)。所以
// 同一支測試裡先證明「點下去真的會出現一個」,那個 0 才有話語權。
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

// 可編輯的 TipTap。唯讀那些是 contenteditable="false"(AnnotatableContent)或
// 根本不是 .ProseMirror(StaticContent),所以這個選擇器只數得到真的輸入框。
const LIVE_EDITORS = '.ProseMirror[contenteditable="true"]';

// 分頁按鈕挑看得見的那顆 —— 切走的分頁還掛在 DOM 裡(KeepAlive)。
const tab = (page, name) => page.locator('button:visible', { hasText: name }).first();

async function openDiscussion(page, { draft = null } = {}) {
  await page.goto(server.origin + '/', { waitUntil: 'domcontentloaded' });
  if (draft) {
    await page.evaluate(
      ([k, v]) => sessionStorage.setItem('draft:' + k, JSON.stringify(v)),
      ['comment:113-050', draft],
    );
  }
  await page.goto(server.origin + '/q/113-050', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(700);
  const t = tab(page, '討論串');
  assert.equal(await t.count(), 1, '找不到「討論串」分頁');
  await t.click();
  await page.waitForTimeout(350);
}

test('開討論串只是看討論,不建編輯器;點一下才建', async (t) => {
  if (guard(t)) return;
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await ctx.route('**/*', (r) =>
    r.request().url().startsWith(server.origin) ? r.continue() : r.abort(),
  );

  try {
    await openDiscussion(page);

    // 空掃防線一:真的停在討論串分頁上。
    assert.match(
      await page.locator('body').innerText(),
      /還沒有討論/,
      '沒有停在討論串分頁上 —— 下面的斷言都不算數',
    );

    // 空掃防線二:輸入的入口看得見。少了這條,「不建編輯器」可以靠把整塊拿掉達成。
    const placeholder = page.locator('[data-comment-composer]:visible');
    assert.equal(await placeholder.count(), 1, '看不到留言輸入的入口');
    assert.match(
      await placeholder.innerText(),
      /寫下你的想法/,
      '入口沒有沿用原本的提示文字,使用者認不出那是輸入框',
    );

    assert.equal(
      await page.locator(LIVE_EDITORS).count(),
      0,
      '只是看討論就建了可編輯的 TipTap —— 那正是這一頁最貴的一次同步工作',
    );

    // 對照組:點下去必須真的長出一個,上面那個 0 才有話語權。
    await placeholder.click();
    await page.waitForTimeout(350);
    assert.equal(
      await page.locator(LIVE_EDITORS).count(),
      1,
      '點了輸入框卻沒有出現編輯器',
    );
  } finally {
    await ctx.close();
  }
});

test('點開之後游標就在裡面,不必再點第二下', async (t) => {
  if (guard(t)) return;
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await ctx.route('**/*', (r) =>
    r.request().url().startsWith(server.origin) ? r.continue() : r.abort(),
  );

  try {
    await openDiscussion(page);
    await page.locator('[data-comment-composer]:visible').click();
    await page.waitForTimeout(350);
    // 少了這條,延後掛載就從「省一次建構」變成「多按一下」—— 那是把成本轉嫁給
    // 每一個真的要留言的人。
    assert.ok(
      await page.evaluate(
        () => document.activeElement?.classList.contains('ProseMirror') ?? false,
      ),
      '編輯器出現了但沒有拿到焦點,使用者得再點一下才能打字',
    );
    await page.keyboard.type('測試留言');
    assert.match(
      await page.locator(LIVE_EDITORS).innerText(),
      /測試留言/,
      '打進去的字沒有進到編輯器',
    );
  } finally {
    await ctx.close();
  }
});

test('有未送出的草稿時直接展開 —— 看不見的草稿等於弄丟了', async (t) => {
  if (guard(t)) return;
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await ctx.route('**/*', (r) =>
    r.request().url().startsWith(server.origin) ? r.continue() : r.abort(),
  );

  try {
    await openDiscussion(page, {
      draft: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: '沒送出的半句話' }] }],
      },
    });
    assert.equal(
      await page.locator(LIVE_EDITORS).count(),
      1,
      '有草稿卻沒有展開編輯器 —— 使用者會以為草稿掉了',
    );
    assert.match(
      await page.locator(LIVE_EDITORS).innerText(),
      /沒送出的半句話/,
      '展開了但草稿沒有帶回來',
    );
  } finally {
    await ctx.close();
  }
});

test('按「回覆」直接進到可以打字的狀態 —— 那一下就是意圖', async (t) => {
  if (guard(t)) return;
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();

  // fixture 那一題沒有留言,而「回覆」要有留言才存在 —— 形狀由測試注入,
  // 不改 fixture(它是好幾支測試共用的素材)。
  const comments = [
    {
      id: 'c1',
      question_id: '113-050',
      parent_id: null,
      author_email: 'other@example.com',
      display_name: '某人',
      avatar_key: null,
      content_json: JSON.stringify({
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: '第一則留言' }] }],
      }),
      created_at: 1,
      helpful_count: 0,
      voted_by_me: 0,
      adopted: 0,
    },
  ];
  await ctx.route('**/*', (r) => {
    const url = r.request().url();
    if (!url.startsWith(server.origin)) return r.abort();
    if (/\/api\/questions\/113-050\/comments$/.test(url)) {
      return r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(comments),
      });
    }
    if (/\/api\/questions\/113-050$/.test(url)) {
      return r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ...JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'questions_113-050.json'), 'utf8')),
          comment_count: comments.length,
        }),
      });
    }
    return r.continue();
  });

  try {
    await openDiscussion(page);
    // 空掃防線:留言真的畫出來了,「回覆」才會存在。
    assert.match(await page.locator('body').innerText(), /第一則留言/, '留言沒有畫出來');
    const reply = page.locator('button:visible', { hasText: '回覆' }).first();
    assert.equal(await reply.count(), 1, '找不到「回覆」');
    await reply.click();
    await page.waitForTimeout(350);
    // 最上面那顆輸入框仍然是收起來的,所以這裡數到的一定是回覆框。
    assert.equal(
      await page.locator(LIVE_EDITORS).count(),
      1,
      '按了回覆卻還要再點一下佔位框 —— 那一下已經表達過意圖了',
    );
  } finally {
    await ctx.close();
  }
});

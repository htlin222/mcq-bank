// 聊天大廳的「撤回訊息」。
//
// 撤回最容易錯的地方不是「按鈕有沒有反應」,是**內容還留著幾份副本**:回覆是
// 去正規化的快照(`reply_snippet`),所以同一段文字在畫面上可能有好幾份。漏掉
// 任何一份,使用者看到的就是「我按了撤回,字還在」—— 而且只有在有人引用過那則
// 訊息時才看得到,自己測多半不會發現。
//
// 副本的邏輯本身有純函式測試(`src/chat/recall.test.ts`);這支驗的是**接線**:
// 按鈕在不在對的訊息上、兩段確認有沒有真的擋住第一下、送出去的訊框對不對、
// 以及伺服器廣播回來之後畫面有沒有真的把每一份都換掉。
//
// WebSocket 用 Playwright 的 routeWebSocket 整條攔下來假扮伺服器 —— 這一頁的
// 資料**只**從那條 socket 來,fixture 伺服器給不了。
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

// me.json 的身分 —— 訊息是不是「我的」全靠這個比對,寫死另一個字串的話
// 「撤回鈕只出現在自己的訊息上」那條會驗成反的。
const ME = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'me.json'), 'utf8'));

const SECRET = '這句話等一下要撤回:骨髓抹片我看錯了';

function msg(over) {
  return {
    id: 1,
    email: 'member1@example.com',
    name: 'member1',
    text: 'hi',
    mentions: '[]',
    mention_all: 0,
    reply_to: null,
    reply_name: null,
    reply_snippet: null,
    created_at: Date.now() - 60_000,
    deleted_at: null,
    ...over,
  };
}

const MINE = msg({ id: 11, email: ME.email, name: ME.display_name, text: SECRET });
// 引用我的那則 —— 快照裡存著一份**一模一樣的文字**。這一列就是這支測試的重點。
const QUOTE = msg({
  id: 12,
  text: '同意,那張圖確實不好判讀',
  reply_to: 11,
  reply_name: ME.display_name,
  reply_snippet: SECRET,
  created_at: Date.now() - 30_000,
});
const THEIRS = msg({ id: 13, email: 'member2@example.com', name: 'member2', text: '別人的訊息' });

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
  if (REQUIRE) assert.fail(`E2E_REQUIRE=1 但無法執行:${skipReason}`);
  t.skip(skipReason);
  return true;
}

// ⚠️ **每一顆按鈕都要 `exact: true`。** Playwright 的 `name` 預設是**子字串**
// 比對,而回覆的引用區是一顆 `<button>`,它的可及名稱含著被引用訊息的全文 ——
// 上面那段 SECRET 裡剛好就有「撤回」兩個字(刻意留著:真實訊息本來就可能提到)。
// 不加 exact 的話,「別人的訊息上沒有撤回鈕」會驗成 1 !== 0,而原因跟撤回功能
// 完全無關。

/** 假扮聊天室 DO:回一份 init,並把 page → server 的訊框收下來給測試檢查。 */
async function openChat(t) {
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    serviceWorkers: 'block',
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  const sent = [];
  let route = null;
  await page.routeWebSocket('**/api/chat/ws', (ws) => {
    route = ws;
    ws.onMessage((raw) => {
      // ChatProvider 每 30 秒送一次 'ping' 保活,不是我們要看的東西。
      if (raw === 'ping') return;
      try {
        sent.push(JSON.parse(raw));
      } catch {
        /* 非 JSON —— 忽略 */
      }
    });
    ws.send(
      JSON.stringify({
        type: 'init',
        messages: [MINE, QUOTE, THEIRS],
        reactions: [],
        online: [{ email: ME.email, name: ME.display_name }],
      }),
    );
  });

  await page.goto(`${server.origin}/chat`, { waitUntil: 'domcontentloaded' });
  // 空掃防線:訊息真的畫出來了。少了它,底下「找不到撤回鈕」之類的斷言會紅在
  // 一個看起來像功能壞掉、其實是 socket 沒接上的地方。
  await page.locator('#chat-msg-11').waitFor({ timeout: 20_000 });
  t.after(async () => {
    await ctx.close();
  });
  return { ctx, page, errors, sent, broadcast: (o) => route.send(JSON.stringify(o)) };
}

test('撤回鈕只出現在自己的訊息上', async (t) => {
  if (guard(t)) return;
  const { ctx, page, errors } = await openChat(t);
  try {
    const btn = (id) => page.locator(`#chat-msg-${id}`).getByRole('button', { name: '撤回', exact: true });
    // 正面先立起來:找不到的話,底下那個 0 什麼都沒證明。
    assert.equal(await btn(11).count(), 1, '自己的訊息上找不到撤回鈕');
    assert.equal(await btn(13).count(), 0, '別人的訊息上不該有撤回鈕');
    // 引用列裡也不該有(那一則是別人送的)。
    assert.equal(await btn(12).count(), 0, '別人的回覆上不該有撤回鈕');
    assert.deepEqual(errors, []);
  } finally {
    await ctx.close();
  }
});

test('兩段確認:第一下只是問,沒有送出任何東西', async (t) => {
  if (guard(t)) return;
  const { ctx, page, errors, sent } = await openChat(t);
  try {
    const row = page.locator('#chat-msg-11');
    await row.getByRole('button', { name: '撤回', exact: true }).click();

    // ① 換成第二段,而且**什麼都還沒送出去**。撤回不可逆(伺服器上文字真的被
    //    抹掉),而這顆按鈕跟「回覆」只差一顆按鈕的距離。
    const confirm = row.getByRole('button', { name: '確定撤回', exact: true });
    await confirm.waitFor({ timeout: 5_000 });
    assert.equal(
      sent.filter((m) => m.type === 'recall').length,
      0,
      '第一下就把撤回送出去了',
    );

    // ② 點訊息區的空白處要收得回去 —— 跟表情面板共用同一條關閉路徑。
    await page.locator('#chat-msg-13').click();
    await confirm.waitFor({ state: 'detached', timeout: 5_000 });
    assert.equal(sent.filter((m) => m.type === 'recall').length, 0);
    assert.deepEqual(errors, []);
  } finally {
    await ctx.close();
  }
});

test('撤回之後,原文的每一份副本都要從畫面上消失', async (t) => {
  if (guard(t)) return;
  const { ctx, page, errors, sent, broadcast } = await openChat(t);
  try {
    // 對照組:現在畫面上有**兩份** —— 訊息本身,以及引用它的那則回覆的快照。
    const body = () => page.locator('body').innerText();
    const before = await body();
    assert.ok(before.includes(SECRET), '訊息本身沒有畫出來');
    assert.match(
      await page.locator('#chat-msg-12').innerText(),
      new RegExp(SECRET.slice(0, 12)),
      '引用列裡沒有快照 —— 這支測試最重要的那一份不存在,等於什麼都沒驗',
    );

    const row = page.locator('#chat-msg-11');
    await row.getByRole('button', { name: '撤回', exact: true }).click();
    await row.getByRole('button', { name: '確定撤回', exact: true }).click();

    // 送出去的訊框要對。伺服器只認送出者本人,所以 client 只需要送 id。
    await page.waitForTimeout(300);
    const recalls = sent.filter((m) => m.type === 'recall');
    assert.equal(recalls.length, 1, `送出的 recall 訊框數不對:${JSON.stringify(sent)}`);
    assert.equal(recalls[0].id, 11);

    // 伺服器廣播回來(真的 DO 會在抹掉儲存之後做這件事)。
    broadcast({ type: 'recall', id: 11, deleted_at: Date.now() });
    await page.locator('#chat-msg-11').getByText('你已撤回訊息').waitFor({ timeout: 5_000 });

    assert.match(
      await page.locator('#chat-msg-12').innerText(),
      /訊息已撤回/,
      '引用列的快照沒有跟著抹掉 —— 撤回等於沒撤回',
    );
    const after = await body();
    assert.ok(!after.includes(SECRET), '撤回之後畫面上還留著原文');
    // 別人的訊息不該被牽連。
    assert.ok(after.includes('別人的訊息'), '把別人的訊息一起清掉了');
    assert.deepEqual(errors, []);
  } finally {
    await ctx.close();
  }
});

test('撤回過的訊息不再給回覆與表情 —— 墓碑上沒有東西可指', async (t) => {
  if (guard(t)) return;
  const { ctx, page, errors, broadcast } = await openChat(t);
  try {
    const row = page.locator('#chat-msg-11');
    // 對照組:撤回之前這兩顆都在。
    assert.equal(await row.getByRole('button', { name: '回覆', exact: true }).count(), 1);
    assert.equal(await row.getByRole('button', { name: '加上表情', exact: true }).count(), 1);

    broadcast({ type: 'recall', id: 11, deleted_at: Date.now() });
    await row.getByText('你已撤回訊息').waitFor({ timeout: 5_000 });

    assert.equal(await row.getByRole('button', { name: '回覆', exact: true }).count(), 0);
    assert.equal(await row.getByRole('button', { name: '加上表情', exact: true }).count(), 0);
    assert.equal(await row.getByRole('button', { name: '撤回', exact: true }).count(), 0);
    assert.deepEqual(errors, []);
  } finally {
    await ctx.close();
  }
});

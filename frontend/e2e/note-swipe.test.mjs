// 個人筆記卡的左右滑動換筆記。
//
// 方向判準的邊界(位移下限、角度、邊緣護欄、時長)全都在
// `src/lib/swipeNav.test.ts` —— 在瀏覽器裡用手勢試探這些門檻會隨引擎飄。
// 這裡驗的是**接線**:手勢有沒有真的接到筆記卡上、換過去的是不是下一則、
// 以及那幾道護欄在真的 DOM 上有沒有生效。
//
// ⚠️ Playwright 的 `page.touchscreen` 只有 `tap()`,`page.mouse` 發的是滑鼠事件
// (而這個功能刻意只吃 touch —— 見 hooks/useSwipeNav.ts)。所以手勢是用
// `document.createTouch` / `createTouchList` 合成的:WebKit 沒有 `new Touch()`
// (Illegal constructor),但這一組舊 API 還在,實測可用。
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

// 期望值從 fixture 推出來,不寫死 —— 那份筆記是好幾支測試共用的素材,
// 標題被改動過一次就會弄紅一支跟它無關的測試(gamepad.test.mjs 踩過)。
const FIXTURE = JSON.parse(
  fs.readFileSync(path.join(HERE, 'fixtures', 'questions_113-050.json'), 'utf8'),
);
const TITLES = FIXTURE.my_notes.map((n) => {
  const doc = JSON.parse(n.content_json);
  const first = (doc.content ?? []).find((b) => b.content?.length);
  return (first?.content ?? []).map((c) => c.text ?? '').join('').trim();
});

const W = 390;
const H = 780;

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

/** 手機是分頁版:先切到「題目以外」,筆記欄才渲染得出來。 */
async function openNoteTab(page) {
  const tab = page.locator('button:visible', { hasText: '詳解' }).first();
  if (await tab.count()) await tab.click().catch(() => {});
  await page.waitForTimeout(200);
  await page.locator('button:visible', { hasText: '個人筆記' }).first().click();
  await page.waitForTimeout(400);
}

/**
 * 在筆記卡上合成一次滑動。回傳 false 代表卡片根本不在畫面上 —— 呼叫端要當成
 * 錯誤,不是「沒換筆記」:少了這道,選擇器一腐爛整支就變成空掃的綠燈。
 *
 * `at` 可以指定起手點。事件**派發在那一點底下的元素上**,不是卡片上 ——
 * `e.target` 決定了「手指底下有沒有東西還捲得動」那道護欄看得到什麼。
 */
async function swipe(page, { dx, dy = 0, ms = 200, fromX = null, at = null }) {
  const ok = await page.evaluate(
    ({ dx, dy, ms, fromX, at }) => {
      const card = [...document.querySelectorAll('article')].find(
        (el) => el.getClientRects().length && /僅你可見/.test(el.textContent || ''),
      );
      if (!card) return false;
      const r = card.getBoundingClientRect();
      const x0 = at ? at.x : (fromX ?? Math.round(r.left + r.width / 2));
      const y0 = at
        ? at.y
        : Math.round(r.top + Math.min(r.height, window.innerHeight) / 2);
      const target = document.elementFromPoint(x0, y0) ?? card;

      const touchAt = (x, y) => {
        const t = document.createTouch(window, target, 1, x, y, x, y);
        return document.createTouchList(t);
      };
      const fire = (type, list) =>
        target.dispatchEvent(
          new TouchEvent(type, {
            bubbles: true,
            cancelable: true,
            touches: type === 'touchend' ? document.createTouchList() : list,
            targetTouches: type === 'touchend' ? document.createTouchList() : list,
            changedTouches: list,
          }),
        );

      fire('touchstart', touchAt(x0, y0));
      fire('touchmove', touchAt(x0 + dx / 2, y0 + dy / 2));
      // timeStamp 由引擎給,是「事件建立的當下」—— 所以時長靠真的等。
      return new Promise((res) => {
        setTimeout(() => {
          fire('touchend', touchAt(x0 + dx, y0 + dy));
          res(true);
        }, ms);
      });
    },
    { dx, dy, ms, fromX, at },
  );
  await page.waitForTimeout(250);
  return ok;
}

/** 切換器上顯示的那一則筆記的標題。 */
const CURRENT = `document.querySelector('[title="切換這一題的筆記"]').textContent`;

test('左右滑動換上一則 / 下一則筆記', async (t) => {
  if (guard(t)) return;

  const ctx = await browser.newContext({
    viewport: { width: W, height: H },
    isMobile: true,
    hasTouch: true,
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  try {
    await page.goto(server.origin + '/q/113-050', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(800);
    await openNoteTab(page);

    // 正面對照:兩則筆記都在,而且現在停在第一則。少了這段,底下每一條
    // 「標題沒變」的斷言在功能整個消失時也會成立。
    assert.equal(TITLES.length, 2, 'fixture 要有兩則筆記');
    const start = await page.evaluate(CURRENT);
    assert.ok(start.includes(TITLES[0]), `一開始該停在第一則,實際:${start}`);
    assert.ok(start.includes('1/2'), `切換器該顯示 1/2,實際:${start}`);

    assert.ok(await swipe(page, { dx: -150 }), '找不到筆記卡');
    let now = await page.evaluate(CURRENT);
    assert.ok(now.includes(TITLES[1]), `左滑該到第二則,實際:${now}`);
    assert.ok(now.includes('2/2'), `切換器該顯示 2/2,實際:${now}`);

    assert.ok(await swipe(page, { dx: 150 }), '找不到筆記卡');
    now = await page.evaluate(CURRENT);
    assert.ok(now.includes(TITLES[0]), `右滑該回到第一則,實際:${now}`);

    assert.deepEqual(errors, [], '不該有未捕捉的例外');
  } finally {
    await ctx.close();
  }
});

test('捲動與返回手勢不會被當成換筆記', async (t) => {
  if (guard(t)) return;

  const ctx = await browser.newContext({
    viewport: { width: W, height: H },
    isMobile: true,
    hasTouch: true,
  });
  const page = await ctx.newPage();

  try {
    await page.goto(server.origin + '/q/113-050', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(800);
    await openNoteTab(page);

    const first = await page.evaluate(CURRENT);
    assert.ok(first.includes(TITLES[0]), `一開始該停在第一則,實際:${first}`);

    // ① 斜著滑 —— 讓給捲動。
    assert.ok(await swipe(page, { dx: -150, dy: 140 }), '找不到筆記卡');
    assert.ok(
      (await page.evaluate(CURRENT)).includes(TITLES[0]),
      '斜著滑不該換筆記',
    );

    // ② 從左邊緣起滑 —— 讓給 iOS 的返回手勢。
    assert.ok(await swipe(page, { dx: 150, fromX: 5 }), '找不到筆記卡');
    assert.ok(
      (await page.evaluate(CURRENT)).includes(TITLES[0]),
      '從螢幕邊緣起滑不該換筆記',
    );

    // ③ 慢慢拖 —— 那是在選字,不是滑。
    assert.ok(await swipe(page, { dx: -150, ms: 900 }), '找不到筆記卡');
    assert.ok(
      (await page.evaluate(CURRENT)).includes(TITLES[0]),
      '拖太久不該換筆記',
    );

    // 對照組:同樣的位移,快滑就換得動 —— 少了這條,上面三條在功能沒接上時
    // 也全綠。
    assert.ok(await swipe(page, { dx: -150 }), '找不到筆記卡');
    assert.ok(
      (await page.evaluate(CURRENT)).includes(TITLES[1]),
      '快滑該換得動筆記(上面三條的對照組)',
    );
  } finally {
    await ctx.close();
  }
});

test('手指落在會左右捲的東西上時,滑動是捲它,不是換筆記', async (t) => {
  if (guard(t)) return;

  const ctx = await browser.newContext({
    viewport: { width: W, height: H },
    isMobile: true,
    hasTouch: true,
  });

  // 第一則筆記改成「含一張表」—— AnnotatableContent 會把它包進 `.table-scroll`
  // (overflow-x:auto),而表格 min-width: 36rem,390px 上必定捲得動。這也正是
  // 真實情境:從 OpenEvidence 匯進來的整理表就長這樣。
  // **改的是回應,不是 fixture 檔**:那份筆記是好幾支測試共用的素材
  // (gamepad.test.mjs 踩過)。
  const cell = (tag, text) => ({
    type: tag,
    attrs: { colspan: 1, rowspan: 1, colwidth: null },
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  });
  const wide = JSON.parse(JSON.stringify(FIXTURE));
  wide.my_notes[0].content_json = JSON.stringify({
    type: 'doc',
    content: [
      // ⚠️ 標題用 paragraph 不用 heading:`NoteContent` 會把 heading 底下的內容
      // 收成手風琴,而**收合的區段不渲染子節點** —— 表格根本不會進 DOM,
      // 這支測試就變成在驗一個不存在的東西。
      { type: 'paragraph', content: [{ type: 'text', text: TITLES[0] }] },
      {
        type: 'table',
        content: [
          {
            type: 'tableRow',
            // ⚠️ 欄要夠多、字要夠長。prosemirror-tables 會在 <table> 上寫一個
            // **行內** min-width(每欄 25px),那會蓋掉 styles.css 的 36rem ——
            // 所以「表格會不會超出容器」是由真實內容決定的,不是那條規則。
            // 三欄短字的表格量出來 316/316,完全捲不動,測試就什麼都沒驗到。
            content: [
              'Immunoglobulinemia',
              'Cryoglobulinemia',
              'Spherocytosis',
              'Haptoglobin',
              'Reticulocytosis',
              'Methemoglobinemia',
            ].map((t) => cell('tableHeader', t)),
          },
          {
            type: 'tableRow',
            content: [
              'Warm',
              'Cold',
              'Paroxysmal',
              'Autoimmune',
              'Microangiopathic',
              'Hereditary',
            ].map((t) => cell('tableCell', t)),
          },
        ],
      },
    ],
  });
  await ctx.route('**/api/questions/113-050*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify(wide),
    }),
  );

  const page = await ctx.newPage();
  try {
    await page.goto(server.origin + '/q/113-050', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(800);
    await openNoteTab(page);

    // 正面對照:那段程式碼真的可以左右捲。少了這條,底下「沒換筆記」的斷言在
    // 「根本沒渲染出 pre」時也會成立 —— 又是一個空掃的綠燈。
    const box = await page.evaluate(() => {
      const wrap = [...document.querySelectorAll('.table-scroll')].find(
        (el) => el.getClientRects().length,
      );
      if (!wrap) return null;
      const r = wrap.getBoundingClientRect();
      // 表格外面的一點,拿來當對照組。這則筆記很短(標題 + 一張表),卡片的
      // 幾何中心正好落在表格上 —— 用預設起手點的話對照組會跟著被攔下來。
      const card = wrap.closest('article');
      const cr = card.getBoundingClientRect();
      return {
        scrollable: wrap.scrollWidth > wrap.clientWidth + 1,
        x: Math.round(r.left + r.width / 2),
        y: Math.round(r.top + r.height / 2),
        outsideY: Math.round(Math.min(r.bottom + 24, cr.bottom - 12)),
        outsideBelowTable: r.bottom + 24 < cr.bottom - 12,
      };
    });
    assert.ok(box, '找不到看得見的表格(.table-scroll)');
    assert.ok(box.scrollable, '那張表該是左右可捲的,否則這支測試什麼都沒驗到');

    assert.ok(
      (await page.evaluate(CURRENT)).includes(TITLES[0]),
      '一開始該停在第一則',
    );

    // 從表格上起手往左滑 —— 該是捲它。
    assert.ok(
      await swipe(page, { dx: -150, at: { x: box.x, y: box.y } }),
      '找不到筆記卡',
    );
    assert.ok(
      (await page.evaluate(CURRENT)).includes(TITLES[0]),
      '在可左右捲的表格上橫拖不該換筆記',
    );

    // 對照組:同樣的滑動,起手落在表格外面就換得動。
    assert.ok(box.outsideBelowTable, '表格底下要留得出一塊空間當對照組的起手點');
    assert.ok(
      await swipe(page, { dx: -150, at: { x: box.x, y: box.outsideY } }),
      '找不到筆記卡',
    );
    assert.ok(
      (await page.evaluate(CURRENT)).includes(TITLES[1]),
      '落在表格外面的同一個手勢該換得動(上一條的對照組)',
    );
  } finally {
    await ctx.close();
  }
});

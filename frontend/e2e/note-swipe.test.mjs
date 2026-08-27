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

      const list = (x, y) =>
        document.createTouchList(document.createTouch(window, target, 1, x, y, x, y));
      const fire = (type, tl) =>
        target.dispatchEvent(
          new TouchEvent(type, {
            bubbles: true,
            cancelable: true,
            touches: type === 'touchend' ? document.createTouchList() : tl,
            targetTouches: type === 'touchend' ? document.createTouchList() : tl,
            changedTouches: tl,
          }),
        );

      // 位移過程中量到的最大 translateX —— 「卡片有沒有跟著手指走」靠它。
      window.__dragPeak = 0;
      const STEPS = 6;
      fire('touchstart', list(x0, y0));
      return new Promise((res) => {
        let i = 1;
        const step = () => {
          if (i > STEPS) {
            fire('touchend', list(x0 + dx, y0 + dy));
            res(true);
            return;
          }
          fire('touchmove', list(x0 + (dx * i) / STEPS, y0 + (dy * i) / STEPS));
          const m = /translateX\((-?[\d.]+)px\)/.exec(card.style.transform || '');
          if (m) window.__dragPeak = Math.max(window.__dragPeak, Math.abs(+m[1]));
          i++;
          setTimeout(step, Math.max(1, Math.round(ms / STEPS)));
        };
        setTimeout(step, Math.max(1, Math.round(ms / STEPS)));
      });
    },
    { dx, dy, ms, fromX, at },
  );
  // 過臨界點時會先飛出去(170ms)再換內容,所以要等久一點。
  await page.waitForTimeout(500);
  return ok;
}

/** 上一次 swipe() 過程中,卡片實際位移過的最大距離。 */
const DRAG_PEAK = `window.__dragPeak || 0`;

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

    // ③ ⚠️ 慢慢拖**現在該換得動**。舊版有一個 700ms 上限(用來擋選字),但卡片
    //    跟著手指走之後,「慢慢拖過臨界點」是正常操作 —— 用時間擋會讓一個正確
    //    的手勢無聲彈回去。選字改由鎖定當下的 selection 檢查擋(見下一支測試)。
    assert.ok(await swipe(page, { dx: -150, ms: 900 }), '找不到筆記卡');
    assert.ok(
      (await page.evaluate(CURRENT)).includes(TITLES[1]),
      '慢慢拖過臨界點該換得動 —— 直接操作沒有時間上限',
    );
    // 換回第一則,好讓下面的對照組從同一個起點開始。
    assert.ok(await swipe(page, { dx: 150 }), '找不到筆記卡');
    assert.ok((await page.evaluate(CURRENT)).includes(TITLES[0]));

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

test('卡片跟著手指走:沒到臨界點會彈回原位,過了才換', async (t) => {
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
    assert.ok(
      (await page.evaluate(CURRENT)).includes(TITLES[0]),
      '一開始該停在第一則',
    );

    // ① 拖一小段就放手 —— 390px 上臨界點約 86px,拖 40px 不該換。
    assert.ok(await swipe(page, { dx: -40, ms: 300 }), '找不到筆記卡');

    // **卡片真的動過** —— 這才是這次改動的重點。少了這條,整個「跟著手指走」
    // 拿掉之後上面每一條「換不換」的測試仍然全綠。
    const peak = await page.evaluate(DRAG_PEAK);
    assert.ok(peak > 10, `拖曳過程中卡片該跟著位移,實際峰值 ${peak}px`);
    // 1:1 跟手:臨界點之前不衰減,所以峰值該接近實際拖的距離。
    assert.ok(peak <= 40 + 1, `臨界點之前該 1:1 跟手,實際 ${peak}px`);

    // 沒到臨界點 → 沒換,而且回到原位。
    assert.ok(
      (await page.evaluate(CURRENT)).includes(TITLES[0]),
      '沒到臨界點不該換筆記',
    );
    await page.waitForTimeout(300);
    const rested = await page.evaluate(() => {
      const card = [...document.querySelectorAll('article')].find(
        (el) => el.getClientRects().length && /僅你可見/.test(el.textContent || ''),
      );
      return card ? card.style.transform : 'NO-CARD';
    });
    assert.ok(
      rested === '' || /translateX\(0px\)/.test(rested),
      `該彈回原位,實際 transform="${rested}"`,
    );

    // ② 拖過臨界點 → 換過去(對照組:證明上面的「沒換」不是因為功能壞了)。
    assert.ok(await swipe(page, { dx: -150, ms: 300 }), '找不到筆記卡');
    assert.ok(
      (await page.evaluate(CURRENT)).includes(TITLES[1]),
      '拖過臨界點該換筆記',
    );
  } finally {
    await ctx.close();
  }
});

test('橡皮筋:拖得再遠,卡片位移也不會等比例跟著跑', async (t) => {
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

    // 拖到遠超過臨界點(390px 上臨界點約 86px)。
    assert.ok(await swipe(page, { dx: -320, ms: 300 }), '找不到筆記卡');
    const peak = await page.evaluate(DRAG_PEAK);
    // 有動,但明顯比手指走的少 —— 「變重」本身就是回饋。
    assert.ok(peak > 80, `該超過臨界點,實際 ${peak}px`);
    assert.ok(peak < 200, `超過臨界點後該衰減,實際 ${peak}px(手指走了 320px)`);
  } finally {
    await ctx.close();
  }
});

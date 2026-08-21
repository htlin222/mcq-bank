// 選字工具列的「複製成圖卡」(#173)。
//
// 版面計算是純函式(`src/lib/cardLayout.test.ts`)、交付方式的挑選也是
// (`src/lib/shareCard.test.ts`)。這裡驗的是**中間那一段接線**:按鈕出不出現、
// 按下去有沒有真的產出 PNG、結構有沒有從 DOM 走到畫面上,以及那個 Safari 坑。
//
// ⚠️ 剪貼簿在 headless WebKit 沒有權限,所以 `ClipboardItem` 與
// `navigator.clipboard.write` 由測試自己接管 —— 驗的是「我們交出去的東西對不對」,
// 不是瀏覽器有沒有真的貼進系統剪貼簿(那不是我們能控制的)。
//
// ⚠️ 詳解由 `ctx.route` 注入,**不改 fixture** —— `questions_113-050.json` 是好幾支
// 測試共用的素材(note-reorder / gamepad 都吃它)。
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

let browser;
let server;
let baseQuestion;
let skipReason = null;

before(async () => {
  if (!fs.existsSync(path.join(DIST, 'index.html'))) {
    skipReason = `找不到 ${DIST}/index.html —— 先跑 pnpm --dir frontend build`;
    return;
  }
  baseQuestion = JSON.parse(
    fs.readFileSync(path.join(HERE, 'fixtures', 'questions_113-050.json'), 'utf8'),
  );
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

const p = (text) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const li = (text) => ({ type: 'listItem', content: [p(text)] });

const h = (level, text) => ({ type: 'heading', attrs: { level }, content: [{ type: 'text', text }] });

/**
 * 三層巢狀的個人筆記。
 *
 * ⚠️ `NoteContent` 把**每一個**標題渲染成 `<button data-note-heading>`,不是
 * `h1..h6` —— 所以「掃 h1..h6」在筆記裡永遠空手。這份 fixture 存在的唯一理由
 * 就是釘住那條路徑。
 */
const NESTED_NOTE = {
  type: 'doc',
  content: [
    h(1, '一、溶血機轉'),
    h(2, '(1) 血管內溶血'),
    h(3, 'a. Haptoglobin 的角色'),
    p('游離血紅素與 haptoglobin 結合後由肝臟清除,故血管內溶血時 haptoglobin 下降。'),
  ],
};

const CMP_ITEMS = ['甲乙丙丁戊己庚辛', '壬癸甲乙丙丁', '戊己庚辛壬癸甲乙丙丁'];
/** `.tiptap` 直接子節點的索引 —— 用位置定位比 CSS 選擇器精確(li 裡也有 p)。 */
const CHILD = { LIST: 3, CMP_PARA: 7, CMP_LIST: 8 };

/** 有標題階層、巢狀清單與有序清單的詳解 —— 圖卡要保留的東西都在裡面。 */
const EXPLANATION = {
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: '二、診斷準則' }] },
    { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: '(1) 必要條件' }] },
    p('CAD 的診斷需要同時滿足下列條件，缺一不可：'),
    {
      type: 'bulletList',
      content: [
        li('慢性溶血性貧血的證據'),
        {
          type: 'listItem',
          content: [
            p('冷凝集素效價 ≥ 1:64'),
            { type: 'bulletList', content: [li('單株 IgM kappa 最常見')] },
          ],
        },
        li('DAT 對 C3d 陽性'),
      ],
    },
    { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: '(2) 處置順序' }] },
    { type: 'orderedList', content: [li('先排除續發性原因'), li('再評估是否需要治療')] },
    // 等量對照:下面這一段落與這一份清單的**字元完全相同**,只差結構。
    // 結構若被壓平(退回 range.toString()),兩張卡會一樣高 —— 這是唯一能
    // 分辨「真的有讀 DOM」與「只是把文字倒出來」的量法。
    { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: '(3) 等量對照' }] },
    p(CMP_ITEMS.join('')),
    { type: 'bulletList', content: CMP_ITEMS.map(li) },
  ],
};

/**
 * 攔截剪貼簿。
 *
 * `captureThenable` 記的是「交給 ClipboardItem 的東西是不是還沒解出來的
 * Promise」—— 那正是 Safari 那個坑的判準,見 shareCard.deliverCard。
 */
const STUB = ({ withClipboard }) => {
  window.__card = { calls: 0, thenable: null, type: null, w: 0, h: 0 };
  Object.defineProperty(navigator, 'canShare', {
    configurable: true,
    value: () => false,
  });
  if (!withClipboard) {
    // 沒有 ClipboardItem 的瀏覽器 —— 應該退回下載。
    delete window.ClipboardItem;
    return;
  }
  window.ClipboardItem = class {
    constructor(items) {
      this.items = items;
      const v = items['image/png'];
      window.__card.thenable = typeof v?.then === 'function';
    }
  };
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      write: async (items) => {
        window.__card.calls += 1;
        const blob = await items[0].items['image/png'];
        window.__card.type = blob.type;
        const bmp = await createImageBitmap(blob);
        window.__card.w = bmp.width;
        window.__card.h = bmp.height;
        // 麵包屑在不在,只能量像素 —— 卡片高度會被內文長度騙過(那個判準實際
        // 上假綠過一次)。
        //
        // 取樣帶 y∈[150,172] 是**量出來的**,不是算出來的:有麵包屑時那裡是
        // 麵包屑文字、內文從 y=256 才開始;沒有麵包屑時內文整段上移到 y=176,
        // 那一帶全白。不要改成掃 accent 色 —— 引言左側那條直線也是 accent,
        // 沒有麵包屑時它正好落在同一帶。
        const cv = new OffscreenCanvas(bmp.width, bmp.height);
        const cx = cv.getContext('2d');
        cx.drawImage(bmp, 0, 0);
        const band = cx.getImageData(150, 150, 1050, 22).data;
        let dark = 0;
        for (let i = 0; i < band.length; i += 4) {
          if (band[i] + band[i + 1] + band[i + 2] < 420) dark++;
        }
        window.__card.crumbBandDark = dark;
      },
    },
  });
};

async function openQuestion(withClipboard = true) {
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    // SW 會攔截 fixture 請求,route 就攔不到了(見 e2e-selection-toolbar 的舊坑)。
    serviceWorkers: 'block',
  });
  await ctx.addInitScript(STUB, { withClipboard });
  await ctx.route('**/api/questions/113-050', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify({
        ...baseQuestion,
        explanation: {
          ...baseQuestion.explanation,
          content_json: JSON.stringify(EXPLANATION),
        },
        my_notes: [
          {
            ...(baseQuestion.my_notes?.[0] ?? {}),
            slot: 0,
            content_json: JSON.stringify(NESTED_NOTE),
          },
        ],
      }),
    }),
  );
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(server.origin + '/q/113-050', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(900);
  // 防劇透遮罩帶著 `select-none`,沒揭曉的詳解**選不起來**(兩個引擎皆然,
  // 這是正確行為)。不先按這一下,選取會是空的而工具列永遠不出現。
  const reveal = page.locator('button', { hasText: '點擊顯示詳解' });
  if (await reveal.count()) {
    await reveal.first().click();
    await page.waitForTimeout(400);
  }
  return { ctx, page, errors };
}

/**
 * 選取詳解裡的一段,並讓工具列看得到。
 *
 * `mouseup` 必須從**元素**派發:從 document 派發時 `onSettle` 的
 * `e.target.closest` 會炸(document 沒有 closest)。
 */
async function selectChild(page, index) {
  return page.evaluate((index) => {
    const root = document.querySelector('.tiptap');
    if (!root) return { ok: false, reason: '找不到 .tiptap' };
    const el = root.children[index];
    if (!el) return { ok: false, reason: `.tiptap 沒有第 ${index} 個子節點` };
    const r = document.createRange();
    r.selectNodeContents(el);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    return { ok: true, tag: el.tagName, text: sel.toString().slice(0, 30) };
  }, index);
}

/** 選一段 → 按按鈕 → 回傳剪貼簿收到的 PNG 資訊。 */
async function cardFor(page, index) {
  const sel = await selectChild(page, index);
  assert.ok(sel.ok, sel.reason);
  assert.ok(sel.text.length > 0, `第 ${index} 個子節點選不到文字(防劇透還蓋著?)`);
  await page.evaluate(() => {
    window.__card.calls = 0;
  });
  const btn = page.locator('[data-selection-toolbar] button', {
    hasText: /複製成圖卡|下載圖卡|分享圖卡/,
  });
  await btn.waitFor({ state: 'visible', timeout: 4000 });
  await btn.click();
  await page.waitForFunction(() => window.__card.calls > 0, null, { timeout: 8000 });
  return page.evaluate(() => ({ ...window.__card }));
}

test('按下按鈕會產出 2x PNG', async (t) => {
  if (guard(t)) return;
  const { ctx, page, errors } = await openQuestion();
  try {
    const got = await cardFor(page, CHILD.LIST);
    assert.equal(got.type, 'image/png', '剪貼簿只收 image/png');
    assert.equal(got.w, 2160, `設計寬 1080 的 2x 應該是 2160,實際 ${got.w}`);
    assert.ok(got.h > 400, `卡片高度不合理:${got.h}`);
    assert.deepEqual(errors, [], '有未攔截的例外');
  } finally {
    await ctx.close();
  }
});

test('清單結構真的有進到卡片裡 —— 對照組的字元完全相同', async (t) => {
  if (guard(t)) return;
  // 這一條是為了不要假綠而存在的。單純「清單卡比段落卡高」在結構被壓平時
  // **照樣會過**(退回 range.toString() 之後字更多所以更高),所以對照組的
  // 字元必須完全一樣:高度差只可能來自符號、縮排與逐項間距。
  const { ctx, page, errors } = await openQuestion();
  try {
    const para = await cardFor(page, CHILD.CMP_PARA);
    const list = await cardFor(page, CHILD.CMP_LIST);
    assert.ok(
      list.h - para.h >= 120,
      `字元相同時清單卡(${list.h})應明顯高於段落卡(${para.h}) —— ` +
        '差距太小表示結構沒被讀出來,只是把文字倒出來畫',
    );
    assert.deepEqual(errors, [], '有未攔截的例外');
  } finally {
    await ctx.close();
  }
});

test('剪貼簿收到的是尚未 await 的 Promise —— Safari 的 user-gesture 坑', async (t) => {
  if (guard(t)) return;
  const { ctx, page, errors } = await openQuestion();
  try {
    await cardFor(page, CHILD.CMP_PARA);
    assert.equal(
      await page.evaluate(() => window.__card.thenable),
      true,
      'ClipboardItem 拿到的已經是解好的 Blob —— 那表示有人先 await 了 renderCard(),' +
        'Safari 會丟 NotAllowedError,而 Chrome 不會,所以本機測不出來',
    );
    assert.deepEqual(errors, [], '有未攔截的例外');
  } finally {
    await ctx.close();
  }
});

test('沒有 ClipboardItem 的瀏覽器:文案改成「下載圖卡」', async (t) => {
  if (guard(t)) return;
  const { ctx, page, errors } = await openQuestion(false);
  try {
    const sel = await selectChild(page, CHILD.CMP_PARA);
    assert.ok(sel.ok, sel.reason);
    const toolbar = page.locator('[data-selection-toolbar]');
    await toolbar.waitFor({ state: 'visible', timeout: 4000 });
    // 說「複製」卻跳出下載很像壞掉 —— 文案要跟著實際會發生的事走。
    await page
      .locator('[data-selection-toolbar] button', { hasText: '下載圖卡' })
      .waitFor({ state: 'visible', timeout: 4000 });
    assert.equal(
      await page.locator('[data-selection-toolbar] button', { hasText: '複製成圖卡' }).count(),
      0,
      '不支援剪貼簿時不該還寫著「複製」',
    );
    assert.deepEqual(errors, [], '有未攔截的例外');
  } finally {
    await ctx.close();
  }
});

test('個人筆記的麵包屑:標題是手風琴按鈕,不是 h1..h6', async (t) => {
  if (guard(t)) return;
  // 回報的症狀:在筆記裡按「複製成圖卡」,麵包屑整條不見。成因是 NoteContent
  // 把標題渲染成 <button data-note-heading>,而階層是**真的巢狀在 DOM 裡**,
  // 不在扁平的標題序列上。
  const { ctx, page, errors } = await openQuestion();
  try {
    await page.locator('button', { hasText: '個人筆記' }).first().click();
    await page.waitForTimeout(600);
    // 手風琴預設收合 —— 收合的區段不渲染子節點,選不到最深那一段。
    for (let i = 0; i < 4; i++) {
      const n = await page.evaluate(() => {
        const shut = [...document.querySelectorAll('[data-note-heading]')].filter(
          (b) => b.getAttribute('aria-expanded') === 'false',
        );
        for (const b of shut) b.click();
        return shut.length;
      });
      if (!n) break;
      await page.waitForTimeout(250);
    }

    const depth = await page.evaluate(() => {
      const d = (el) => {
        let n = 0;
        for (let e = el; e; e = e.parentElement) {
          if (e.firstElementChild?.matches?.('[data-note-heading]')) n++;
        }
        return n;
      };
      const ps = [...document.querySelectorAll('p')].filter((x) => x.textContent.trim().length > 8);
      ps.sort((a, c) => d(c) - d(a));
      const el = ps[0];
      if (!el) return { ok: false };
      const r = document.createRange();
      r.selectNodeContents(el);
      const s = getSelection();
      s.removeAllRanges();
      s.addRange(r);
      el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      return { ok: true, depth: d(el), realHeadings: el.closest('.tiptap')?.querySelectorAll('h1,h2,h3').length ?? 0 };
    });
    assert.ok(depth.ok, '找不到筆記內容');
    assert.equal(depth.depth, 3, `應該落在三層手風琴裡,實際 ${depth.depth} —— fixture 或渲染改了`);
    assert.equal(depth.realHeadings, 0, '筆記裡出現了真的 h1..h3,這支測試的前提沒了');

    await page.evaluate(() => {
      window.__card.calls = 0;
    });
    const btn = page.locator('[data-selection-toolbar] button', {
      hasText: /複製成圖卡|下載圖卡|分享圖卡/,
    });
    await btn.waitFor({ state: 'visible', timeout: 4000 });
    await btn.click();
    await page.waitForFunction(() => window.__card.calls > 0, null, { timeout: 8000 });
    const withCrumbs = await page.evaluate(() => window.__card.h);

    // ⚠️ 這條斷言換過兩次判準,兩次都假綠:
    //   1. 「卡片高度 >= 500」—— 停掉手風琴路徑後卡片照樣夠高(內文佔位)
    //   2. 「掃 accent 像素」—— 引言左側那條直線也是 accent,沒有麵包屑時
    //      它正好移到同一帶
    // 現在量的是麵包屑**文字**所在的那一帶。停用修正時實測為 0。
    const dark = await page.evaluate(() => window.__card.crumbBandDark);
    assert.ok(
      dark > 100,
      `麵包屑那一列沒有畫出來(該帶深色像素 ${dark} 個,卡片高 ${withCrumbs})`,
    );
    assert.deepEqual(errors, [], '有未攔截的例外');
  } finally {
    await ctx.close();
  }
});

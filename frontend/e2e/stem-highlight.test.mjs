// 題幹的否定詞標紅加粗(#149)。
//
// 切分是純函式(`src/lib/stemHighlight.test.ts` 14 條),這裡只驗**畫出來的樣子**:
// 有沒有真的變紅變粗、沒有否定詞的題目會不會多包一層、以及 e-ink 底下顏色被中和
// 之後語意還在不在。
//
// 題幹由測試注入(`ctx.route`)而不是改 fixture —— fixture 的題幹/筆記是好幾支
// 測試共用的素材,改了會紅在無關的地方(gamepad 那條實際踩過)。
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
const THEME_KEY = 'hema-2026:theme';
const QID = '113-050';
const FIXTURE = path.join(HERE, 'fixtures', `questions_${QID}.json`);

const PROBE = `
  (() => {
    const p = [...document.querySelectorAll('p')].find(
      (e) => /font-serif/.test(e.className) && e.textContent.trim().length > 20);
    if (!p) return null;
    return {
      stem: p.textContent.trim(),
      marks: [...p.querySelectorAll('strong')].map((s) => {
        const cs = getComputedStyle(s);
        return {
          text: s.textContent,
          color: cs.color,
          weight: Number(cs.fontWeight),
          underline: cs.textDecorationLine.includes('underline'),
        };
      }),
    };
  })()
`;

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

/** 開題目頁,題幹換成指定字串。 */
async function withStem(stem, theme = 'light') {
  const ctx = await browser.newContext({ viewport: { width: 900, height: 800 } });
  await ctx.addInitScript(([k, v]) => localStorage.setItem(k, v), [THEME_KEY, theme]);
  await ctx.route(`**/api/questions/${QID}`, (route) => {
    const q = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
    q.stem = stem;
    return route.fulfill({
      status: 200,
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify(q),
    });
  });
  const page = await ctx.newPage();
  await page.goto(`${server.origin}/q/${QID}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(900);
  const r = await page.evaluate(PROBE);
  await ctx.close();
  return r;
}

test('否定詞標紅加粗', async (t) => {
  if (guard(t)) return;
  const r = await withStem('Which one is INCORRECT about 何者錯誤 and not true?');

  assert.ok(r, '找不到題幹 —— 選擇器腐爛了,這條測試沒在驗東西');
  assert.deepEqual(
    r.marks.map((m) => m.text),
    ['INCORRECT', '錯誤', 'not true'],
  );
  for (const m of r.marks) {
    assert.ok(m.weight >= 700, `${m.text} 不夠粗:${m.weight}`);
    // rose-700 = rgb(190, 18, 60)。只斷言「紅遠多於綠藍」,免得改一階色就紅。
    const [red, green, blue] = m.color.match(/\d+/g).map(Number);
    assert.ok(red > green + 80 && red > blue + 80, `${m.text} 不是紅的:${m.color}`);
  }
});

test('沒有否定詞的題目原樣渲染,不多包一層', async (t) => {
  if (guard(t)) return;
  // 對照組。少了它,「把每個字都標起來」也會讓上面那條通過。
  const stem = '下列敘述何者正確?非何杰金氏淋巴瘤的分期依據為何?';
  const r = await withStem(stem);

  assert.ok(r);
  assert.equal(r.stem, stem, '題幹的文字不該被改動');
  assert.deepEqual(r.marks, [], '「正確」「非何杰金氏」不該被標起來');
});

test('題幹的文字內容完全不變 —— 只是包了標記', async (t) => {
  if (guard(t)) return;
  const stem = 'Which statement is wrong about MPNs? (A) 甲 (B) 乙';
  const r = await withStem(stem);
  assert.equal(r.stem, stem);
  assert.deepEqual(r.marks.map((m) => m.text), ['wrong']);
});

test('e-ink:顏色被中和成黑色,語意改由底線承擔', async (t) => {
  if (guard(t)) return;
  // 1-bit 底下紅色不存在(見 CLAUDE.md 的電子紙那節)。粗體活得下來,再加一條
  // 底線 —— 「顏色沒了之後,語意要換一個維度重講」。
  const r = await withStem('Which one is INCORRECT?', 'eink');

  assert.ok(r);
  assert.deepEqual(r.marks.map((m) => m.text), ['INCORRECT']);
  const m = r.marks[0];
  const [red, green, blue] = m.color.match(/\d+/g).map(Number);
  assert.ok(
    red === green && green === blue,
    `e-ink 下不該有彩色:${m.color}`,
  );
  assert.ok(m.underline, 'e-ink 下要有底線 —— 否則跟一般粗體分不出來');
  assert.ok(m.weight >= 700);
});

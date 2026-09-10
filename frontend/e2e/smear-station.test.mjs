// 跑台(/smear/station)—— 完整旅程 + 洩題掃描。
//
// 設計:docs/plans/2026-09-09-smear-station-design.md
//
// 這支的核心是**負面斷言**:下診斷之前,整頁原始碼裡不准出現這個案例的
// 正解、任何一段 reveal_note、或整案討論。而負面斷言在「頁面根本沒載入」
// 時也會成立 —— 所以每一條都先斷言「東西真的在畫面上」再斷言「答案不在」,
// 而且最後有一條**自我驗證**:故意讓 GET 回應帶上 reveal_note,掃描要抓得到。
// 少了那一條,掃描器壞掉的時候整支是全綠的(同 smear-practice 的 noleak)。
//
//   pnpm --dir frontend build && node --test frontend/e2e/smear-station.test.mjs

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(HERE, '..', 'dist');
const REQUIRE = process.env.E2E_REQUIRE === '1';

let browser, server, skipReason = null;

before(async () => {
  if (!fs.existsSync(path.join(DIST, 'index.html'))) {
    skipReason = `找不到 ${DIST}/index.html —— 先跑 pnpm --dir frontend build`;
    return;
  }
  let webkit;
  try { ({ webkit } = await import('playwright')); }
  catch { skipReason = '沒有 playwright'; return; }
  try { browser = await webkit.launch(); }
  catch (e) { skipReason = `WebKit 起不來:${e.message.split('\n')[0]}`; return; }
  server = await startServer({ dist: DIST });
});
after(async () => { if (server) await server.close(); if (browser) await browser.close(); });

function guard(t) {
  if (!skipReason) return false;
  if (REQUIRE) throw new Error(skipReason);
  t.skip(skipReason);
  return true;
}

// 這個案例的正解與說明文字。⚠️ 掃描要找的就是這幾個字串 —— 它們在
// POST /answer 之前不准出現在畫面上的任何地方。
const CASE_ID = 'kfs-l5-c6';
const SECRETS = [
  'acute promyelocytic leukemia',
  'APL',
  'suspect AML',                        // reveal_note 的一段
  'leukemic promyelocyte',              // reveal_note 的另一段
  '這一案的整案討論只有揭曉後才看得到',   // discussion
];

const CASE_PAYLOAD = {
  id: CASE_ID,
  source: 'kfs',
  source_ref: 'Smear-5.pdf#Case6',
  attribution: '和信醫院血液腫瘤科 徐千富',
  history_md: '48 歲女性,因全血球低下就醫\n2022/08/01 WBC 1200/uL, Hb 8.1g/dL, Plt 22000/uL',
  steps: [
    { idx: 0, modality: ['pb'], image_key_view: 'smear/case/x/00-view.webp', image_key_full: 'smear/case/x/00-full.webp', caption: '2022/08/01 PB smear' },
    { idx: 1, modality: ['bm'], image_key_view: 'smear/case/x/01-view.webp', image_key_full: 'smear/case/x/01-full.webp', caption: '2022/08/03 BM smear' },
    { idx: 2, modality: ['pb'], image_key_view: 'smear/case/x/02-view.webp', image_key_full: 'smear/case/x/02-full.webp', caption: '2022/08/05 PB smear' },
  ],
};

const VERDICT = {
  tier: 'full', score: 1, matched: 'APL', canonical: 'acute promyelocytic leukemia',
  spellingErrors: [], dx_id: 'apl',
  discussion: ['這一案的整案討論只有揭曉後才看得到'],
  reveals: [
    { idx: 0, reveal_note: '2022/08/01 PB smear:no obvious blast' },
    { idx: 1, reveal_note: '2022/08/03 BM smear:suspect AML' },
    { idx: 2, reveal_note: '2022/08/05 PB smear:leukemic promyelocyte' },
  ],
};

// ⚠️ 掃 DOM 不夠,要連**回應本文**一起掃。
// 洩在 payload 裡但目前的 UI 剛好沒渲染的字串,`page.content()` 看不到 ——
// 而「目前剛好沒渲染」不是保證,下一次改版就可能開始渲染它。設計說的是
// 「揭曉前不進 payload」,所以驗的也要是 payload。
function watchBodies(ctx, bag) {
  ctx.on('response', async (res) => {
    if (!res.url().includes('/api/smear/station')) return;
    try { bag.push(await res.text()); } catch { /* 導覽中斷,忽略 */ }
  });
}

async function openCase(ctx, { leakOnGet = false, bodies } = {}) {
  const page = await ctx.newPage();
  if (bodies) watchBodies(ctx, bodies);
  await ctx.route('**/api/smear/station/cases', (r) =>
    r.fulfill({ contentType: 'application/json', body: JSON.stringify({ cases: [
      { id: CASE_ID, source: 'kfs', steps: 3, teaser: '48 歲女性,因全血球低下就醫', modalities: ['pb', 'bm'], my_attempts: 0, last_tier: null },
    ] }) }));
  await ctx.route(`**/api/smear/station/cases/${CASE_ID}`, (r) => {
    const body = leakOnGet
      // 自我驗證用:伺服器如果哪天不小心把揭曉文字放進 GET,掃描要抓得到。
      ? { ...CASE_PAYLOAD, steps: CASE_PAYLOAD.steps.map((s, i) => ({ ...s, reveal_note: VERDICT.reveals[i].reveal_note })) }
      : CASE_PAYLOAD;
    r.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  });
  await ctx.route(`**/api/smear/station/cases/${CASE_ID}/answer`, (r) =>
    r.fulfill({ contentType: 'application/json', body: JSON.stringify(VERDICT) }));
  await ctx.route('**/img/**', (r) =>
    r.fulfill({ contentType: 'image/gif', body: Buffer.from('R0lGODlhAQABAAAAACw=', 'base64') }));
  await page.goto(`${server.origin}/smear/station/${CASE_ID}`, { waitUntil: 'domcontentloaded' });
  await page.getByText('臨床病史').waitFor({ timeout: 8000 });
  return page;
}

function found(html, bodies = []) {
  const hay = [html, ...bodies].join('\n');
  return SECRETS.filter((s) => hay.includes(s));
}

test('跑台:病史與第一張圖先出現,而正解一個字都沒有', async (t) => {
  if (guard(t)) return;
  const ctx = await browser.newContext({ serviceWorkers: 'block' });
  const bodies = [];
  const page = await openCase(ctx, { bodies });
  // 正面:東西真的在畫面上(少了這段,下面的負面斷言在空白頁上也會過)
  assert.match(await page.textContent('body'), /48 歲女性/);
  assert.match(await page.textContent('body'), /第 1 \/ 3 張/);
  assert.deepEqual(found(await page.content(), bodies), []);
  await ctx.close();
});

test('跑台:一路按到最後一張,中途沒有任何回饋也沒有洩題', async (t) => {
  if (guard(t)) return;
  const ctx = await browser.newContext({ serviceWorkers: 'block' });
  const bodies = [];
  const page = await openCase(ctx, { bodies });
  await page.getByPlaceholder(/寫下這一張的所見/).fill('全血球低下,沒看到明顯 blast');
  await page.getByRole('button', { name: '下一張' }).click();
  await page.getByText('第 2 / 3 張').waitFor();
  assert.deepEqual(found(await page.content(), bodies), [], '第 2 張就洩題了');
  await page.getByRole('button', { name: '下一張' }).click();
  await page.getByText('第 3 / 3 張').waitFor();
  assert.deepEqual(found(await page.content(), bodies), [], '第 3 張就洩題了');
  // 最後一張沒有「下一張」
  assert.equal(await page.getByRole('button', { name: '下一張' }).count(), 0);
  await ctx.close();
});

test('跑台:送出診斷後才揭曉,而且逐張並排「你寫的」與「原文」', async (t) => {
  if (guard(t)) return;
  const ctx = await browser.newContext({ serviceWorkers: 'block' });
  const page = await openCase(ctx);
  await page.getByPlaceholder(/寫下這一張的所見/).fill('沒有明顯 blast');
  await page.getByPlaceholder('拼出診斷名稱').fill('APL');
  await page.getByRole('button', { name: /送出診斷並揭曉/ }).click();
  await page.getByText('完全正確').waitFor({ timeout: 8000 });
  const html = await page.content();
  // 揭曉後,三段 reveal_note 與整案討論都要出現
  assert.ok(html.includes('suspect AML'), '揭曉後看不到 reveal_note');
  assert.ok(html.includes('這一案的整案討論只有揭曉後才看得到'), '揭曉後看不到整案討論');
  // 使用者自己寫的那一段也要被留住 —— 那是「中途不回饋」唯一的補償
  assert.ok(html.includes('沒有明顯 blast'), '揭曉後看不到自己當初寫的');
  await ctx.close();
});

test('跑台:自我驗證 —— GET 意外帶了 reveal_note 時,掃描要抓得到', async (t) => {
  if (guard(t)) return;
  const ctx = await browser.newContext({ serviceWorkers: 'block' });
  const bodies = [];
  const page = await openCase(ctx, { leakOnGet: true, bodies });
  // ⚠️ 這一條刻意期待「掃得到」。它證明上面三條的 deepEqual([]) 不是因為
  //    掃描器壞掉才過的。這裡洩的是 payload 而不是畫面 —— 只掃 DOM 的版本
  //    抓不到它(實測會綠),那正是加上 watchBodies 的理由。
  const leaked = found(await page.content(), bodies);
  assert.ok(leaked.length > 0, '掃描器抓不到刻意放進去的洩題 —— 上面三條的綠燈沒有意義');
  await ctx.close();
});

test('跑台清單:卡片顯示病史摘要,不顯示投影片標題', async (t) => {
  if (guard(t)) return;
  const ctx = await browser.newContext({ serviceWorkers: 'block' });
  const page = await ctx.newPage();
  await ctx.route('**/api/smear/station/cases', (r) =>
    r.fulfill({ contentType: 'application/json', body: JSON.stringify({ cases: [
      { id: CASE_ID, source: 'kfs', steps: 3, teaser: '48 歲女性,因全血球低下就醫', modalities: ['pb', 'bm'], my_attempts: 0, last_tier: null },
    ] }) }));
  await page.goto(`${server.origin}/smear/station`, { waitUntil: 'domcontentloaded' });
  await page.getByText('48 歲女性,因全血球低下就醫').waitFor({ timeout: 8000 });
  assert.deepEqual(found(await page.content()), [], '清單頁就洩題了');
  await ctx.close();
});

// #274 抹片作答斷線後補送。
// 第一趟 POST 失敗要留在這台裝置;重整後補送打同一支 /answer。
// 複習模式補送成功要揭曉,而且 hint_used 原樣再送一次。
// 全真模式補送的回應與交卷前的頁面都不能出現正解;交卷成績要算進這一題。
// 同一題兩次寫入只留一列,由 worker/lib/smear-answer-retry.test.ts 對真的
// INSERT … ON CONFLICT 上鎖。這裡的 mock 只鏡射那個覆寫。

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(HERE, '..', 'dist');
const REQUIRE = process.env.E2E_REQUIRE === '1';
const SECRET = 'ZYXWVU-RETRY-CANONICAL-274';

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

function installRetryBackend(ctx, { mode, sessionId }) {
  const realId = 'q274';
  const state = { answers: new Map(), finished: false, finishedAt: null };
  const calls = { answer: [], answerResponses: [] };
  const json = (route, body, status = 200) =>
    route.fulfill({
      status,
      contentType: 'application/json; charset=utf-8',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify(body),
    });

  ctx.route('**/api/smear/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname;
    const method = req.method();

    if (method === 'GET' && p === `/api/smear/dx/dx274`) {
      return json(route, {
        id: 'dx274',
        canonical_long: 'not-the-secret',
        canonical_abbrev: null,
        topic: 'rbc',
        qtype: 'cell',
        terms: [],
        rejected: [],
        proposals: [],
        note: null,
        related: [],
      });
    }

    if (method === 'GET' && p === `/api/smear/sessions/${sessionId}`) {
      const reveal = mode === 'review' || state.finished;
      const answer = state.answers.get(realId);
      return json(route, {
        id: sessionId,
        mode,
        config: { mode, n: 1, form: 'any' },
        started_at: Date.now(),
        finished_at: state.finished ? state.finishedAt : null,
        questions: [
          {
            id: reveal ? realId : '#0',
            dx_id: reveal ? 'dx274' : undefined,
            source: 'exam',
            image_key_view: 'smear/exam/q274-view.webp',
            image_key_full: 'smear/exam/q274-full.webp',
            prompt: '這是什麼細胞?',
            image_note: null,
            topic: 'rbc',
            qtype: 'cell',
            answered: !!answer,
            my_tier: reveal && answer ? answer.tier : undefined,
            my_score: reveal && answer ? answer.score : undefined,
          },
        ],
      });
    }

    if (method === 'POST' && p === `/api/smear/sessions/${sessionId}/initial`) {
      if (mode !== 'review') return json(route, { error: 'forbidden' }, 403);
      return json(route, { initial: 'Z' });
    }

    if (method === 'POST' && p === `/api/smear/sessions/${sessionId}/answer`) {
      const body = JSON.parse(req.postData() || '{}');
      calls.answer.push(body);
      if (calls.answer.length === 1) {
        return json(route, { error: 'offline' }, 500);
      }
      state.answers.set(realId, {
        tier: 'full',
        score: 1,
        typed: body.boxes,
        hintUsed: body.hintUsed ?? null,
      });
      const res =
        mode === 'review'
          ? {
              tier: 'full',
              score: 1,
              matched: body.boxes?.[0] ?? null,
              canonical: SECRET,
              spellingErrors: [],
              acceptedTerms: [],
            }
          : { ok: true };
      calls.answerResponses.push(res);
      return json(route, res);
    }

    if (method === 'POST' && p === `/api/smear/sessions/${sessionId}/finish`) {
      if (!state.finished) {
        state.finished = true;
        state.finishedAt = Date.now();
      }
      const answer = state.answers.get(realId);
      return json(route, {
        score: answer ? 1 : 0,
        max_score: 1,
        spelling_ok: answer ? 1 : 0,
        lay_count: 0,
        question_count: 1,
        breakdown: [
          {
            question_id: realId,
            dx_id: 'dx274',
            canonical_long: SECRET,
            topic: 'rbc',
            typed: answer?.typed ?? [],
            tier: answer?.tier ?? 'miss',
            score: answer ? 1 : 0,
            spelling_errors: [],
          },
        ],
      });
    }

    return json(route, {});
  });

  return { calls, state };
}

test('複習模式:送出失敗留在裝置上,重整後補送會揭曉,提示原樣再送', async (t) => {
  if (guard(t)) return;
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    serviceWorkers: 'block',
  });
  const { calls, state } = installRetryBackend(ctx, { mode: 'review', sessionId: 'rev-retry' });
  const pageErrors = [];
  try {
    const page = await ctx.newPage();
    page.on('pageerror', (err) => {
      const msg = String(err);
      // 故意讓第一趟 POST 失敗時,WebKit 會另外丟 "Fetch API cannot load … due to
      // access control checks"。那是測試手法的副產物,產品那邊已經 catch。
      // 同 attempt-outbox.test.mjs。只濾這個作答網址,其餘照抓。
      if (msg.includes('/answer') && msg.includes('Fetch API cannot load')) return;
      pageErrors.push(msg);
    });
    await page.goto(`${server.origin}/smear/s/rev-retry`, { waitUntil: 'domcontentloaded' });
    const input = page.getByPlaceholder('輸入診斷或細胞名稱…');
    await input.waitFor();
    await page.getByRole('button', { name: '首字母' }).click();
    await page.getByTestId('smear-initial').waitFor();
    await input.fill('typed-retry-274');
    await page.getByRole('button', { name: '提交答案' }).click();
    await page.getByText('這台裝置').waitFor();
    assert.equal(await input.inputValue(), 'typed-retry-274');
    assert.equal(calls.answer.length, 1);
    assert.deepEqual(calls.answer[0].boxes, ['typed-retry-274']);
    assert.equal(calls.answer[0].hintUsed, 'initial');
    assert.equal(state.answers.size, 0);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByText(SECRET).waitFor();
    assert.equal(calls.answer.length, 2);
    assert.deepEqual(calls.answer[1].boxes, ['typed-retry-274']);
    assert.equal(calls.answer[1].hintUsed, 'initial');
    assert.equal(calls.answer[1].questionId, calls.answer[0].questionId);
    assert.equal(state.answers.size, 1);
    assert.equal(calls.answerResponses.length, 1);
    assert.equal(calls.answerResponses[0].canonical, SECRET);
    assert.deepEqual(pageErrors, []);
  } finally {
    await ctx.close();
  }
});

test('全真模式:補送回應與交卷前的頁面都沒有正解,成績有算進這一題', async (t) => {
  if (guard(t)) return;
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    serviceWorkers: 'block',
  });
  const { calls, state } = installRetryBackend(ctx, { mode: 'exam', sessionId: 'exam-retry' });
  const pageErrors = [];
  const responseTexts = [];
  try {
    const page = await ctx.newPage();
    page.on('pageerror', (err) => {
      const msg = String(err);
      if (msg.includes('/answer') && msg.includes('Fetch API cannot load')) return;
      pageErrors.push(msg);
    });
    page.on('response', (res) => {
      if (!res.url().includes('/answer')) return;
      responseTexts.push(res.text());
    });
    await page.goto(`${server.origin}/smear/s/exam-retry`, { waitUntil: 'domcontentloaded' });
    const input = page.getByPlaceholder('輸入診斷或細胞名稱…');
    await input.waitFor();
    await input.fill('typed-exam-274');
    await page.getByRole('button', { name: '提交答案' }).click();
    await page.getByText('這台裝置').waitFor();
    assert.equal(await input.inputValue(), 'typed-exam-274');
    assert.equal(await page.getByText(SECRET).count(), 0);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByText('全真模式全程不揭曉判定').waitFor();
    const before = await page.locator('body').innerText();
    assert.equal(before.includes(SECRET), false);
    const html = await page.content();
    assert.equal(html.includes(SECRET), false);
    assert.equal(calls.answer.length, 2);
    assert.deepEqual(calls.answer[1].boxes, ['typed-exam-274']);
    assert.equal(calls.answer[1].questionId, '#0');
    assert.equal(state.answers.size, 1);
    assert.deepEqual(calls.answerResponses, [{ ok: true }]);
    const bodies = await Promise.all(responseTexts);
    assert.ok(bodies.length >= 2, `作答回應只有 ${bodies.length} 筆`);
    for (const body of bodies) {
      assert.equal(body.includes(SECRET), false, body);
    }

    await page.getByRole('button', { name: '查看成績' }).click();
    await page.getByText('typed-exam-274').waitFor();
    const after = await page.locator('body').innerText();
    assert.match(after, /1\s*\/\s*1/);
    assert.equal(after.includes(SECRET), true);
    assert.deepEqual(pageErrors, []);
  } finally {
    await ctx.close();
  }
});

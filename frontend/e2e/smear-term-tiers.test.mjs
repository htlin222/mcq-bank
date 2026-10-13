// #272:診斷頁看得到半對分級與已否決寫法;再提報不會把它救回來。
// 全真作答交卷前,那些字不能出現在畫面上。不改共用 fixture。
//
//   pnpm --dir frontend build && node --test --test-concurrency=1 frontend/e2e/smear-term-tiers.test.mjs

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(HERE, '..', 'dist');
const REQUIRE = process.env.E2E_REQUIRE === '1';
const DX = JSON.parse(
  fs.readFileSync(path.join(HERE, 'fixtures', 'smear_dx_dacrocyte.json'), 'utf8'),
);

const HALF = 'poikilocyte-half-marker';
const TOMB = 'rejected-tombstone-word';
const WHY = 'too broad to score';

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

function json(route, status, body) {
  return route.fulfill({
    status,
    contentType: 'application/json; charset=utf-8',
    headers: { 'cache-control': 'no-store' },
    body: JSON.stringify(body),
  });
}

function dxBody() {
  const dx = structuredClone(DX);
  dx.terms = [
    ...(dx.terms ?? []),
    { id: 'half-marker', text: HALF, tier: 'half', form: 'long' },
  ];
  dx.rejected = [
    {
      id: 'rej-1',
      text: TOMB,
      tier: 'half',
      form: 'long',
      rationale: WHY,
    },
  ];
  return dx;
}

const EXAM = {
  id: 'exam-tomb',
  mode: 'exam',
  config: { n: 1, form: 'any', topics: ['rbc'], sources: ['ash'] },
  started_at: 1_700_000_000_000,
  finished_at: null,
  questions: [
    {
      id: '#0',
      source: 'ash',
      image_key_view: 'smear/ash/dacrocyte-1-view.webp',
      image_key_full: 'smear/ash/dacrocyte-1-full.webp',
      prompt: 'What cell?',
      image_note: null,
      topic: 'rbc',
      qtype: 'cell',
      answered: false,
    },
  ],
};

test('診斷頁列出半對與已否決,再提報不會恢復;全真作答頁掃不到那些字', async (t) => {
  if (guard(t)) return;
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    serviceWorkers: 'block',
  });
  const posts = [];
  await ctx.route('**/api/smear/dx/dacrocyte**', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/smear/dx/dacrocyte' && route.request().method() === 'GET') {
      return json(route, 200, dxBody());
    }
    if (url.pathname.endsWith('/terms') && route.request().method() === 'POST') {
      posts.push(route.request().postDataJSON());
      return json(route, 409, {
        error: 'this exact wording was already proposed and rejected',
        existingTermId: 'rej-1',
      });
    }
    return route.fallback();
  });
  await ctx.route('**/api/smear/sessions/exam-tomb**', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/smear/sessions/exam-tomb') return json(route, 200, EXAM);
    return json(route, 200, { ok: true });
  });

  const page = await ctx.newPage();
  const errors = [];
  const dxHits = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('request', (req) => {
    if (!page.url().includes('/smear/s/exam-tomb')) return;
    if (req.url().includes('/api/smear/dx/')) dxHits.push(req.url());
  });

  try {
    await page.goto(server.origin + '/smear/dx/dacrocyte', { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: 'Dacrocyte' }).waitFor();
    await page.getByRole('heading', { name: '部分正確(半分)' }).waitFor();
    await page.getByText(HALF).waitFor();
    await page.getByText('dacrocyte').first().waitFor();

    const whyBefore = page.getByText(WHY);
    await whyBefore.waitFor({ state: 'hidden' });
    await page.getByText('已否決的寫法（1）').click();
    await page.getByText(WHY).waitFor({ state: 'visible' });
    await page.getByText(TOMB).waitFor({ state: 'visible' });
    await page.getByText('已否決', { exact: true }).waitFor({ state: 'visible' });

    const halfBlock = page.getByRole('heading', { name: '部分正確(半分)' }).locator('xpath=..');
    assert.equal(await halfBlock.getByText(TOMB).count(), 0, '否決字不該混進半對清單');

    await page.getByPlaceholder('輸入診斷或細胞名稱的另一種寫法…').fill(TOMB);
    await page.getByRole('button', { name: '送出提報' }).click();
    await page.getByText('不會因為再提報一次就恢復').waitFor();
    assert.equal(posts.length, 1, '再提報要真的打到既有的提報流程');
    assert.equal(posts[0].text, TOMB);
    assert.equal(await page.getByText('提報成功').count(), 0);
    assert.equal(await page.getByText('投票中').count(), 0);
    await page.getByText('已否決的寫法（1）').waitFor();

    await page.goto(server.origin + '/smear/s/exam-tomb', { waitUntil: 'domcontentloaded' });
    await page.getByPlaceholder('輸入診斷或細胞名稱…').waitFor();
    const html = await page.content();
    for (const s of [HALF, TOMB, WHY]) {
      assert.equal(html.includes(s), false, `全真作答頁不該出現「${s}」`);
    }
    assert.deepEqual(dxHits, [], '作答中不該去抓診斷詳情');
    assert.deepEqual(errors, []);
  } finally {
    await ctx.close();
  }
});

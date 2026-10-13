// 抹片共筆詳解(#251):管理員能改、別人持鎖時改不了、存檔後重整還在。
//
// 鎖的條件與版本衝突是純函式。這裡驗診斷頁的接線。不改共用 fixture。
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
const DX = JSON.parse(
  fs.readFileSync(path.join(HERE, 'fixtures', 'smear_dx_dacrocyte.json'), 'utf8'),
);
const ME = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'me.json'), 'utf8'));
const MARKER = 'ZZMARKER';

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

function installDx(ctx, lock) {
  const box = { saved: null };
  const done = ctx.route('**/api/smear/dx/dacrocyte**', (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path.endsWith('/note/lock')) {
      if (lock) return json(route, lock.status, lock.body);
      return json(route, 200, { ok: true, until: Date.now() + 300_000 });
    }
    if (path.endsWith('/note/unlock')) return json(route, 200, { ok: true });
    if (path.endsWith('/note') && route.request().method() === 'PUT') {
      box.saved = route.request().postDataJSON();
      return json(route, 200, {
        ok: true,
        version: (box.saved.expected_version ?? 1) + 1,
        updated_by: 'dev@example.com',
        updated_at: Date.now(),
      });
    }
    if (path === '/api/smear/dx/dacrocyte') {
      const dx = structuredClone(DX);
      if (box.saved?.content_json) {
        dx.note.content_json = JSON.stringify(box.saved.content_json);
        dx.note.version = (box.saved.expected_version ?? 1) + 1;
        dx.note.updated_by = 'dev@example.com';
      }
      return json(route, 200, dx);
    }
    return route.fallback();
  });
  return done.then(() => box);
}

async function openDx(page) {
  await page.goto(server.origin + '/smear/dx/dacrocyte', { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: 'Dacrocyte' }).waitFor();
  await page.getByText('一句話').first().waitFor();
}

test('管理員改完存檔,重整後那幾個字還在', async (t) => {
  if (guard(t)) return;
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    serviceWorkers: 'block',
  });
  const box = await installDx(ctx, null);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    await openDx(page);
    const edit = page.getByRole('button', { name: '編輯詳解' });
    assert.equal(await edit.count(), 1, '管理員應該看得到編輯詳解');
    await edit.click();
    const editor = page.locator('.ProseMirror[contenteditable="true"]');
    await editor.waitFor();
    await editor.click();
    const active = await page.evaluate(() => document.activeElement?.className ?? '');
    assert.match(active, /ProseMirror/, `焦點不在編輯器:${active}`);
    await page.keyboard.type(MARKER);
    assert.match(await editor.innerText(), new RegExp(MARKER), '打進去的字沒有進到編輯器');
    await page.getByRole('button', { name: '儲存', exact: true }).click();
    await page.getByText(MARKER).first().waitFor();
    assert.equal(box.saved?.expected_version, 1);
    assert.match(JSON.stringify(box.saved?.content_json), new RegExp(MARKER));

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: 'Dacrocyte' }).waitFor();
    await page.getByText(MARKER).first().waitFor();
    assert.equal(await page.locator('.ProseMirror').count(), 0, '重整後不該還停在編輯器');
    assert.deepEqual(errors, []);
  } finally {
    await ctx.close();
  }
});

test('別人持鎖時不開編輯器,畫面上寫著是誰', async (t) => {
  if (guard(t)) return;
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    serviceWorkers: 'block',
  });
  await installDx(ctx, {
    status: 423,
    body: { error: 'locked', locked_by: 'other@example.com', until: Date.now() + 60_000 },
  });
  const page = await ctx.newPage();
  try {
    await openDx(page);
    await page.getByRole('button', { name: '編輯詳解' }).click();
    await page.getByText('other@example.com 正在編輯').waitFor();
    assert.equal(await page.locator('.ProseMirror').count(), 0);
    assert.equal(await page.getByRole('button', { name: '儲存' }).count(), 0);
  } finally {
    await ctx.close();
  }
});

test('不是管理員沒有編輯詳解', async (t) => {
  if (guard(t)) return;
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    serviceWorkers: 'block',
  });
  await ctx.route('**/api/me', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path !== '/api/me') return route.fallback();
    return json(route, 200, { ...ME, is_admin: false });
  });
  const page = await ctx.newPage();
  try {
    await openDx(page);
    assert.equal(await page.getByRole('button', { name: '編輯詳解' }).count(), 0);
  } finally {
    await ctx.close();
  }
});

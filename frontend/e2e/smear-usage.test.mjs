// 個人頁「抹片使用」(#256):提示次數、俗名命中、主題題量都要畫出來,
// 而且 0 也要在畫面上。fixture 裡 infection 的作答是 0。

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
    skipReason = '沒有 playwright';
    return;
  }
  try {
    browser = await webkit.launch();
  } catch (e) {
    skipReason = `WebKit 起不來:${e.message.split('\n')[0]}`;
    return;
  }
  server = await startServer({ dist: DIST });
});

after(async () => {
  if (server) await server.close();
  if (browser) await browser.close();
});

test('個人頁看得到抹片提示、俗名命中與主題題量', async (t) => {
  if (skipReason) {
    if (REQUIRE) assert.fail(`E2E_REQUIRE=1 但無法執行:${skipReason}`);
    return t.skip(skipReason);
  }
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await ctx.route('**/*', (r) =>
    r.request().url().startsWith(server.origin) ? r.continue() : r.abort(),
  );
  try {
    await page.goto(server.origin + '/profile', { waitUntil: 'domcontentloaded' });
    const card = page.locator('#profile-smear');
    await card.getByText(/7\s*\/\s*11/).waitFor({ timeout: 15_000 });
    const text = await card.innerText();
    assert.match(text, /看選項/);
    assert.match(text, /3/);
    assert.match(text, /俗名層命中\s*5/);
    assert.match(text, /7\s*\/\s*11/);
    assert.match(text, /感染相關/);
    assert.match(text, /2/);
    assert.match(text, /0/);
    const infection = card.locator('tr', { hasText: '感染相關' });
    assert.equal(await infection.count(), 1);
    const cells = await infection.locator('td').allInnerTexts();
    assert.deepEqual(cells.map((s) => s.trim()), ['感染相關', '2', '0']);
    assert.equal(text.includes('spelling_ok'), false);
    assert.deepEqual(errors, []);
  } finally {
    await ctx.close();
  }
});

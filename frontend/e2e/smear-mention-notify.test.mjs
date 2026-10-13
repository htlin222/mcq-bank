// 抹片討論的 @ 通知要能點回該診斷的討論分頁(#250)。
//
// 抽取與「不存在的人不通知」是純函式。這裡驗鈴鐺:徽章在、點那一則
// 進到 /smear/dx/:id?tab=discussion,而且討論分頁是亮的。
// 不改共用的 notifications.json —— 那份是筆試留言的素材。
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

const ITEM = {
  id: 'smear-n1',
  recipient: 'dev@example.com',
  kind: 'smear_mention',
  question_id: null,
  dx_id: 'dacrocyte',
  challenge_id: null,
  actor_email: 'member1@example.com',
  preview: '淚滴狀紅血球的討論',
  read_at: null,
  created_at: 1780000000000,
};

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

function installNotifications(ctx) {
  return ctx.route('**/api/notifications**', (route) => {
    const url = new URL(route.request().url());
    const body = url.pathname.endsWith('/unread-count')
      ? { count: 1 }
      : [ITEM];
    return route.fulfill({
      status: 200,
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify(body),
    });
  });
}

test('通知徽章點進去,開在該診斷的討論分頁', async (t) => {
  if (guard(t)) return;
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await installNotifications(ctx);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    await page.goto(server.origin + '/', { waitUntil: 'domcontentloaded' });
    const bell = page.locator('header button[aria-label="通知"]');
    await bell.waitFor();
    const badge = bell.locator('span');
    await badge.waitFor();
    assert.equal((await badge.innerText()).trim(), '1', '未讀徽章沒有出現');

    await bell.click();
    const link = page.getByRole('link', { name: /在抹片討論提到了你/ });
    await link.waitFor();
    assert.match(await link.innerText(), /淚滴狀紅血球的討論/);
    await link.click();

    await page.waitForURL(/\/smear\/dx\/dacrocyte\?tab=discussion$/);
    await page.getByRole('heading', { name: 'Dacrocyte' }).waitFor();
    const discussion = page.getByRole('tab', { name: '討論' });
    await discussion.waitFor();
    assert.equal(await discussion.getAttribute('aria-selected'), 'true');
    const explanation = page.getByRole('tab', { name: '詳解' });
    assert.equal(await explanation.getAttribute('aria-selected'), 'false');
    assert.deepEqual(errors, []);
  } finally {
    await ctx.close();
  }
});

// #273:看過的首頁抹片 view 圖留在 img-v1。離線再回首頁,這一輪還在。
// 沒看過的圖不整批抓。全螢幕 full 圖這一輪沒開,不該進快取。
//
// SW 真的接管,同 offline-year.test.mjs。content-type 不是 image/ 的拒絕
// 鎖在 sw-guards.test.ts 的 isCacheableImageResponse,這裡不另開一條。
//
//   pnpm --dir frontend build && node --test --test-concurrency=1 frontend/e2e/smear-gallery-offline.test.mjs

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(HERE, '..', 'dist');
const REQUIRE = process.env.E2E_REQUIRE === '1';
const VIEWED = 'smear/ash/60634.jpg';
const FULL = 'smear/ash/60634-full.jpg';
const UNSEEN = [
  'smear/ash/1405.jpg',
  'smear/ash/63187.jpg',
  'smear/ash/64446.jpg',
  'smear/ash/65514.jpg',
];

let browser;
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
});

after(async () => {
  if (browser) await browser.close();
});

function guard(t) {
  if (!skipReason) return false;
  if (REQUIRE) throw new Error(skipReason);
  t.skip(skipReason);
  return true;
}

test('看過的抹片 view 進 img-v1,離線回首頁仍顯示這一輪', async (t) => {
  if (guard(t)) return;
  const server = await startServer({ dist: DIST });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const imgReqs = [];
  page.on('request', (r) => {
    if (r.url().includes('/img/')) imgReqs.push(new URL(r.url()).pathname);
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => {
    try {
      localStorage.setItem('smear-gallery-paused', '1');
    } catch {
      /* ignore */
    }
  });

  try {
    await page.goto(server.origin + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-smear-gallery]');
    await page.waitForTimeout(2000);
    assert.equal(
      await page.evaluate(() => !!navigator.serviceWorker?.controller),
      false,
      '第一次造訪 SW 還沒接管,這時量到的張數才是按之前',
    );
    const before = await page.evaluate(async () => {
      const c = await caches.open('img-v1');
      return (await c.keys()).length;
    });

    await page.goto(server.origin + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!navigator.serviceWorker?.controller, null, {
      timeout: 8000,
    });
    await page.waitForFunction(() => {
      const img = document.querySelector('[data-smear-gallery] img');
      return !!img && img.naturalWidth > 0 && (img.getAttribute('src') || '').includes('60634.jpg');
    });
    await page.waitForFunction(
      async () => {
        const c = await caches.open('img-v1');
        const urls = (await c.keys()).map((k) => k.url);
        return urls.some((u) => u.includes('60634.jpg') && !u.includes('60634-full'));
      },
      null,
      { timeout: 8000 },
    );

    const urls = await page.evaluate(async () => {
      const c = await caches.open('img-v1');
      return (await c.keys()).map((k) => k.url);
    });
    assert.ok(urls.length > before, `看過之後 img-v1 該變多(${before} → ${urls.length})`);
    assert.ok(urls.length - before <= 2, `不該整批進快取,實際多了 ${urls.length - before} 張`);
    assert.ok(urls.some((u) => u.includes(VIEWED) && !u.includes('60634-full')));
    for (const key of [FULL, ...UNSEEN]) {
      assert.equal(
        urls.some((u) => u.includes(key)),
        false,
        `${key} 沒看過,不該在 img-v1`,
      );
      assert.equal(
        imgReqs.some((p) => p.includes(key)),
        false,
        `${key} 不該被抓下來`,
      );
    }
    assert.ok(imgReqs.some((p) => p.includes(VIEWED)));

    await page.getByRole('link', { name: '複習', exact: true }).click();
    await page.waitForURL('**/review');
    await server.close();
    await page.getByRole('link', { name: '首頁', exact: true }).click();
    await page.waitForFunction(() => location.pathname === '/');
    await page.waitForSelector('[data-smear-gallery]');
    await page.getByRole('heading', { name: 'lymphoma', exact: true }).waitFor();
    await page.waitForFunction(() => {
      const img = document.querySelector('[data-smear-gallery] img');
      return !!img && img.naturalWidth > 0 && (img.getAttribute('src') || '').includes('60634.jpg');
    });
    assert.deepEqual(errors, []);
  } finally {
    await ctx.close();
    await server.close().catch(() => {});
  }
});

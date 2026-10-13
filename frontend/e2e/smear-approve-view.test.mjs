// 核准投稿要送出一張比原圖小的 JPEG 檢視圖。
// 伺服器那一側的「兩把 key、≤ 80%」在 worker/lib/smear-approve-images.test.ts。
// 這裡守的是按「核准」真的會把那張圖放進 multipart,而不是只送 dxId。

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { startServer } from './server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(HERE, '..', 'dist');
const REQUIRE = process.env.E2E_REQUIRE === '1';

function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeB = Buffer.from(type);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeB, data])));
  return Buffer.concat([len, typeB, data, crc]);
}

/** 640×480 的雜訊 PNG。平塗的漸層壓完太小,JPEG 反而比較大,門檻會誤殺。 */
function noisyPng(width, height) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let s = 1;
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x++) {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      const i = row + 1 + x * 3;
      raw[i] = s >>> 24;
      raw[i + 1] = (s >>> 16) & 255;
      raw[i + 2] = (s >>> 8) & 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const ORIGINAL = noisyPng(640, 480);

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

function guard(t) {
  if (!skipReason) return false;
  if (REQUIRE) assert.fail(`E2E_REQUIRE=1 但無法執行:${skipReason}`);
  t.skip(skipReason);
  return true;
}

test('核准會送出比原圖小的檢視圖', { timeout: 30_000 }, async (t) => {
  if (guard(t)) return;
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    serviceWorkers: 'block',
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.stack || e.message));
  // WebKit 透過 Playwright 看到的 post data 只有 multipart 標頭,檔案位元組是空的
  // (實測整包 282 bytes)。送出去的 File 仍在,改在 fetch 前讀它的大小與檔頭。
  await page.addInitScript(() => {
    const orig = window.fetch;
    window.fetch = async function (input, init) {
      const body = init?.body;
      if (typeof FormData !== 'undefined' && body instanceof FormData) {
        const view = body.get('view');
        if (view instanceof Blob) {
          const head = new Uint8Array(await view.slice(0, 3).arrayBuffer());
          window.__view = { size: view.size, type: view.type, head: [...head] };
        }
      }
      return orig.apply(this, arguments);
    };
  });
  await page.route('**/img/smear/submissions/e2e-1.jpg', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'image/png',
      body: ORIGINAL,
    }),
  );
  try {
    await page.goto(server.origin + '/smear?tab=submit', { waitUntil: 'domcontentloaded' });
    await page.getByRole('tab', { name: '待審核' }).click();
    const hint = page.getByText('淚滴細胞,常見於骨髓纖維化。');
    await hint.waitFor();
    assert.ok(await hint.isVisible(), '待審核的第一筆要在畫面上');
    await page.getByRole('button', { name: '採用建議' }).first().click();
    const reqPromise = page.waitForRequest(
      (r) => r.method() === 'POST' && r.url().includes('/submissions/sub-e2e-pending-1/approve'),
    );
    await page.getByRole('button', { name: '核准' }).first().click();
    const req = await reqPromise;
    const type = req.headers()['content-type'] || '';
    assert.ok(type.includes('multipart/form-data'), `content-type 應是 multipart,實際 ${type}`);
    const body = req.postDataBuffer();
    assert.ok(body.includes('name="dxId"'), 'multipart 要帶 dxId');
    assert.ok(body.includes('dacrocyte'), 'dxId 應是採用的診斷');
    assert.ok(body.includes('name="view"'), 'multipart 要帶 view');
    assert.ok(body.includes('image/jpeg'), '檢視圖應是 jpeg');
    const view = await page.evaluate(() => window.__view);
    assert.equal(view?.type, 'image/jpeg');
    assert.deepEqual(view?.head, [0xff, 0xd8, 0xff]);
    assert.ok(
      view.size * 5 <= ORIGINAL.length * 4,
      `檢視圖 ${view.size} bytes 沒有明顯小於原圖 ${ORIGINAL.length}`,
    );
    await hint.waitFor({ state: 'hidden' });
    assert.deepEqual(errors, []);
  } finally {
    await ctx.close();
  }
});

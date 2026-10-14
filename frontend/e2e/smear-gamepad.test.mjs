// 抹片作答的手把。假的 navigator.getGamepads,真的輪詢與 React state。
// 斷言的是選取真的變了;「沒送出」都配一個後來真的送得出去的對照。

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(HERE, '..', 'dist');
const REQUIRE = process.env.E2E_REQUIRE === '1';
const SECRET = 'PronormoblastSecret';

const BTN = {
  FACE_DOWN: 0,
  FACE_RIGHT: 1,
  FACE_LEFT: 2,
  FACE_UP: 3,
  L1: 4,
  R1: 5,
  DPAD_UP: 12,
  DPAD_DOWN: 13,
  DPAD_LEFT: 14,
  DPAD_RIGHT: 15,
};

const FAKE_PAD = `(() => {
  const buttons = Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 }));
  const pad = {
    id: '8BitDo Pro 2 (STANDARD GAMEPAD Vendor: 2dc8 Product: 6006)',
    index: 0,
    connected: true,
    mapping: 'standard',
    buttons,
    axes: [0, 0, 0, 0],
    timestamp: 0,
    vibrationActuator: { playEffect: () => Promise.resolve('complete') },
  };
  Object.defineProperty(navigator, 'getGamepads', {
    value: () => [pad],
    configurable: true,
    writable: true,
  });
  window.__press = (i, on) => {
    buttons[i].pressed = on;
    buttons[i].value = on ? 1 : 0;
    pad.timestamp = performance.now();
  };
})();`;

async function tap(page, index) {
  await page.evaluate((i) => window.__press(i, true), index);
  await page.waitForTimeout(120);
  await page.evaluate((i) => window.__press(i, false), index);
  await page.waitForTimeout(140);
}

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
  if (REQUIRE) assert.fail(`E2E_REQUIRE=1 但無法執行:${skipReason}`);
  t.skip(skipReason);
  return true;
}

function json(route, body) {
  return route.fulfill({
    status: 200,
    contentType: 'application/json; charset=utf-8',
    headers: { 'cache-control': 'no-store' },
    body: JSON.stringify(body),
  });
}

/** options 有值時,看選項回那份清單。否則回含正解字的清單,讓漏接的按鍵畫得出來。 */
async function openSession(t, sessionId, options) {
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    serviceWorkers: 'block',
  });
  const page = await ctx.newPage();
  const errors = [];
  const box = { answers: [], mc: 0, initial: 0 };
  page.on('pageerror', (e) => errors.push(e.stack || e.message));
  await ctx.route('**/*', (route) => {
    const req = route.request();
    if (!req.url().startsWith(server.origin)) return route.abort();
    const path = new URL(req.url()).pathname;
    if (path.endsWith('/mc-options') && req.method() === 'POST') {
      box.mc += 1;
      return json(route, {
        options: options ?? [SECRET, 'Other cell'],
      });
    }
    if (path.endsWith('/initial') && req.method() === 'POST') {
      box.initial += 1;
      return json(route, { initial: SECRET });
    }
    if (path.endsWith('/answer') && req.method() === 'POST') {
      const body = req.postDataJSON();
      box.answers.push(body);
      if (body?.hintUsed === 'reveal_answer') {
        return json(route, {
          tier: 'miss',
          score: 0,
          canonical: SECRET,
          spellingErrors: [],
        });
      }
      return json(route, { tier: 'miss', score: 0, matched: null, spellingErrors: [] });
    }
    return route.continue();
  });
  await page.addInitScript(FAKE_PAD);
  await page.goto(`${server.origin}/smear/s/${sessionId}`, {
    waitUntil: 'domcontentloaded',
    timeout: 30_000,
  });
  t.after(async () => {
    await ctx.close();
  });
  return { page, errors, box };
}

test('看選項之後十字鍵會改選取,面鍵送出那一項', async (t) => {
  if (guard(t)) return;
  const { page, errors, box } = await openSession(t, 'e2e-1', ['Alpha cell', 'Beta cell']);
  await page.getByRole('button', { name: '看選項' }).waitFor();
  assert.equal(await page.getByText(SECRET).count(), 0);
  assert.equal(await page.getByText('Pronormoblast').count(), 0);

  await page.getByRole('button', { name: '看選項' }).click();
  const radios = page.locator('input[name="smear-mc-choice"]');
  await radios.nth(1).waitFor();
  assert.equal(await radios.nth(0).isChecked(), false, '按之前沒有預設選項');
  assert.equal(await page.getByRole('textbox').count(), 0, '看選項之後輸入框要換掉');

  await tap(page, BTN.DPAD_DOWN);
  assert.equal(await radios.nth(0).isChecked(), true, '沒選過時 ↓ 落在第一個');
  assert.equal(await radios.nth(1).isChecked(), false);

  await tap(page, BTN.DPAD_DOWN);
  assert.equal(await radios.nth(1).isChecked(), true, '再 ↓ 到第二個');

  await tap(page, BTN.DPAD_UP);
  assert.equal(await radios.nth(0).isChecked(), true, '↑ 回到第一個');

  await tap(page, BTN.FACE_DOWN);
  await page.getByTestId('grade-reveal').waitFor();
  assert.equal(box.answers.length, 1);
  assert.equal(box.answers[0].hintUsed, 'mc_choice');
  assert.deepEqual(box.answers[0].boxes, ['Alpha cell']);
  assert.equal(box.initial, 0);
  assert.equal(await page.getByText(SECRET).count(), 0);

  assert.match(await page.getByTestId('smear-progress').innerText(), /1 \/ 2/);
  await tap(page, BTN.R1);
  await page.getByPlaceholder('輸入診斷或細胞名稱…').waitFor();
  assert.match(await page.getByTestId('smear-progress').innerText(), /2 \/ 2/);
  await tap(page, BTN.L1);
  await page.getByTestId('grade-reveal').waitFor();
  assert.match(await page.getByTestId('smear-progress').innerText(), /1 \/ 2/);
  assert.deepEqual(errors, []);
});

test('自由輸入時十字鍵不改字,空框的面鍵也不送出', async (t) => {
  if (guard(t)) return;
  const { page, errors, box } = await openSession(t, 'e2e-1', ['Alpha cell', 'Beta cell']);
  const input = page.getByPlaceholder('輸入診斷或細胞名稱…');
  await input.waitFor();
  await input.click();
  await input.fill('ab');

  await tap(page, BTN.DPAD_DOWN);
  await tap(page, BTN.DPAD_UP);
  await tap(page, BTN.DPAD_LEFT);
  await tap(page, BTN.DPAD_RIGHT);
  assert.equal(await input.inputValue(), 'ab', '十字鍵不該改輸入的字');

  await tap(page, BTN.FACE_LEFT);
  await tap(page, BTN.FACE_UP);
  await tap(page, BTN.FACE_RIGHT);
  await page.waitForTimeout(200);
  assert.equal(box.answers.length, 0, '面鍵不該送出空的或揭曉');
  assert.equal(box.mc, 0);
  assert.equal(box.initial, 0);

  await input.fill('');
  await tap(page, BTN.FACE_DOWN);
  await page.waitForTimeout(200);
  assert.equal(box.answers.length, 0, '空框的送出鍵無作用');

  await input.fill('abc');
  assert.equal(await input.inputValue(), 'abc', '輸入框仍然打得進字');
  await tap(page, BTN.FACE_DOWN);
  await page.getByTestId('grade-reveal').waitFor();
  assert.equal(box.answers.length, 1);
  assert.deepEqual(box.answers[0].boxes, ['abc']);
  assert.notEqual(box.answers[0].hintUsed, 'reveal_answer');
  assert.equal(await page.getByText(SECRET).count(), 0);
  assert.deepEqual(errors, []);
});

test('全真模式按鍵不會把正解畫出來', async (t) => {
  if (guard(t)) return;
  const { page, errors, box } = await openSession(t, 'e2e-2', null);
  const input = page.getByPlaceholder('輸入診斷或細胞名稱…');
  await input.waitFor();
  assert.equal(await page.getByRole('button', { name: '看選項' }).count(), 0);
  assert.equal(await page.getByRole('button', { name: '首字母', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: '不會嗎？直接看答案' }).count(), 0);

  await input.fill('blast');
  for (const key of [BTN.DPAD_DOWN, BTN.DPAD_UP, BTN.DPAD_LEFT, BTN.DPAD_RIGHT, BTN.FACE_LEFT, BTN.FACE_UP, BTN.FACE_RIGHT]) {
    await tap(page, key);
  }
  assert.equal(await input.inputValue(), 'blast');
  assert.equal(box.mc, 0, '全真不該去要選項');
  assert.equal(box.initial, 0, '全真不該去要首字母');
  assert.equal(box.answers.length, 0);

  await tap(page, BTN.FACE_DOWN);
  await page.getByText('已作答').waitFor();
  assert.equal(box.answers.length, 1);
  assert.deepEqual(box.answers[0].boxes, ['blast']);
  assert.notEqual(box.answers[0].hintUsed, 'reveal_answer');
  assert.equal(box.mc, 0);
  const html = await page.content();
  assert.equal(html.includes(SECRET), false);
  assert.equal(await page.getByTestId('grade-reveal').count(), 0);
  assert.deepEqual(errors, []);
});

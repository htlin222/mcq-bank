// 「備份我的紀錄」的整條路(#123):按下按鈕 → 抓完 12 支分頁端點 → 在瀏覽器裡
// 壓成 zip → 觸發下載 → 把下載到的檔案解開,檢查目錄結構與內容。
//
// buildBackupFiles() 的重排邏輯已經在 backupLayout.test.ts 用純函式測過了。
// 這支要證明的是**另外那半**:fetch → zip → download 這條在真的瀏覽器裡接得起來。
// 那一段沒有任何單元測試碰得到 —— fflate 的 async zip 走 worker thread、
// URL.createObjectURL / <a download> 是瀏覽器 API。
//
//   pnpm test:webkit
//
// 沒安裝 playwright / webkit 時預設跳過;CI 設 E2E_REQUIRE=1 改為失敗。

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync, strFromU8 } from 'fflate';
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

test('個人頁按下「下載備份」,拿到一個結構正確的 zip', async (t) => {
  if (skipReason) {
    if (REQUIRE) assert.fail(`E2E_REQUIRE=1 但無法執行:${skipReason}`);
    return t.skip(skipReason);
  }

  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    acceptDownloads: true,
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await ctx.route('**/*', (r) =>
    r.request().url().startsWith(server.origin) ? r.continue() : r.abort(),
  );

  try {
    await page.goto(server.origin + '/profile', {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });
    await page.waitForTimeout(800);

    const btn = page.locator('button', { hasText: '下載備份' }).first();
    // 空掃防線:卡片沒渲染出來的話,下面等下載會超時成一段看不懂的錯誤。
    assert.equal(await btn.count(), 1, '個人頁上找不到「下載備份」');

    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 30_000 }),
      btn.click(),
    ]);

    const name = download.suggestedFilename();
    assert.match(name, /^hema-2026-backup-\d{4}-\d{2}-\d{2}\.zip$/, `檔名不對:${name}`);

    const out = path.join(os.tmpdir(), `hema-backup-e2e-${process.pid}.zip`);
    await download.saveAs(out);
    const files = unzipSync(new Uint8Array(fs.readFileSync(out)));
    fs.rmSync(out, { force: true });

    const root = name.replace(/\.zip$/, '');
    const names = Object.keys(files);
    const read = (rel) => {
      const buf = files[`${root}/${rel}`];
      assert.ok(buf, `zip 裡沒有 ${rel},實際有:${names.join(', ')}`);
      return strFromU8(buf);
    };

    // 每一種來源都要有落點 —— 少了任何一種,備份就是靜靜地不完整。
    const q = JSON.parse(read('questions/113/113-050.json'));
    assert.equal(q.question.answer, 'A');
    assert.equal(q.explanation.version, 2);
    assert.equal(q.my.attempts.length, 1, '作答沒有併進題目檔');
    assert.equal(q.my.confidence.length, 1, '信心沒有併進題目檔');
    assert.equal(q.my.notes.length, 1, '筆記沒有併進題目檔');
    assert.equal(q.my.highlights.length, 1, '畫記沒有併進題目檔');
    assert.equal(q.my.bookmark.folder_name, '待複習');
    assert.equal(q.my.progress.times_seen, 3);

    // 沒有共筆詳解的題目也要在,而且 explanation 是 null。
    const q2 = JSON.parse(read('questions/114/114-001.json'));
    assert.equal(q2.explanation, null);

    const exam = JSON.parse(read('exams/s1.json'));
    assert.equal(exam.session.score, 72);
    assert.equal(exam.answers.length, 1);

    const lec = JSON.parse(read('lectures/heme-review-01.json'));
    assert.equal(lec.title, '紅血球生成與貧血概論');
    assert.equal(lec.annotations[0].page, 12);
    assert.equal(lec.notes[0].page, 18);

    const note = JSON.parse(read('notes/n1.json'));
    assert.equal(note.title, 'anthracycline 心毒性');
    assert.equal(note.highlights.length, 1, '自由筆記的畫記沒有跟著走');

    const manifest = JSON.parse(read('manifest.json'));
    assert.equal(manifest.schema_version, 1);
    assert.equal(manifest.counts.questions, 2);

    // 這份 zip 唯一會被人直接讀的檔案。
    const claude = read('CLAUDE.md');
    assert.match(claude, /只有這個帳號自己的紀錄/);
    assert.match(claude, /questions\/<年>\/<題號>\.json/);

    assert.deepEqual(errors, [], '有未攔截的例外');
  } finally {
    await ctx.close();
  }
});

// 文件用的真實截圖 —— 用正式建置產物 + e2e fixture 伺服器,在 Chromium 裡把每一頁
// 真的渲染出來再拍。輸出到 docs/screenshots/*.webp,給 GitHub Pages 的首頁、
// 使用手冊與 wiki 引用。
//
// 為什麼不用手工截正式站:正式站上的資料是真的成員、真的作答紀錄,截圖等於把它們
// 公開;fixture 是 example.com 的假成員與假題目,而畫的元件跟正式站一字不差。
// 為什麼用 Chromium 而不是 WebKit:這裡要的是「看起來像正式站」的字型與抗鋸齒,
// 不是 iOS 相容性(那是 smoke.test.mjs 的事)。
//
//   pnpm --dir frontend build && node frontend/e2e/screenshots.mjs
//   node frontend/e2e/screenshots.mjs --only smear-   # 只重拍名字含 smear- 的
//
// 需要 cwebp(brew install webp);沒有的話會留 PNG。

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startServer } from './server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(HERE, '..', 'dist');
const FIXTURES = path.join(HERE, 'fixtures');
const OUT = path.join(HERE, '..', '..', 'docs', 'screenshots');
const TMP = path.join(HERE, '..', '..', '.screenshots-tmp');
const THEME_KEY = 'hema-2026:theme';

const only = (() => {
  const i = process.argv.indexOf('--only');
  return i >= 0 ? process.argv[i + 1].split(',') : null;
})();

if (!fs.existsSync(path.join(DIST, 'index.html'))) {
  console.error('frontend/dist 不存在 —— 先 pnpm --dir frontend build');
  process.exit(1);
}
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(TMP, { recursive: true });

const fixture = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.json`), 'utf8'));

// ── 假抹片圖 ────────────────────────────────────────────────────────────────
// fixture 伺服器對 /img/* 一律回 1×1 透明像素,抹片頁會是一片空白。這裡畫一張
// 明顯是示意圖的抹片:淡粉底、散落的紅血球、幾顆有核細胞,角落標「示意圖」。
function smearSvg(seed = 1) {
  let s = seed;
  const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
  const W = 800;
  const H = 600;
  const parts = [];
  for (let i = 0; i < 140; i++) {
    const cx = rnd() * W;
    const cy = rnd() * H;
    const r = 22 + rnd() * 8;
    parts.push(
      `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r.toFixed(1)}" fill="#e9a3a0" opacity="0.85"/>` +
        `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${(r * 0.45).toFixed(1)}" fill="#f6d2cf"/>`,
    );
  }
  for (let i = 0; i < 5; i++) {
    const cx = 120 + rnd() * (W - 240);
    const cy = 100 + rnd() * (H - 200);
    parts.push(
      `<circle cx="${cx}" cy="${cy}" r="46" fill="#c9b4e0"/>` +
        `<circle cx="${cx - 4}" cy="${cy + 2}" r="30" fill="#4b2f7a"/>`,
    );
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">` +
    `<rect width="${W}" height="${H}" fill="#fbeeea"/>${parts.join('')}` +
    `<rect x="${W - 150}" y="${H - 40}" width="140" height="30" rx="4" fill="#fff" opacity="0.85"/>` +
    `<text x="${W - 80}" y="${H - 19}" font-size="14" text-anchor="middle" fill="#5d5240" font-family="sans-serif">示意圖 · mock image</text>` +
    `</svg>`
  );
}

// ── 每個 context 共用的 route 覆寫 ──────────────────────────────────────────
async function installRoutes(ctx, { loggedOut = false } = {}) {
  let seed = 1;
  await ctx.route('**/img/smear/**', (route) =>
    route.fulfill({ status: 200, contentType: 'image/svg+xml', body: smearSvg(seed++) }),
  );
  // users.json 裡有一個非 example.com 的名字 —— 一律改成假名再送進畫面。
  await ctx.route('**/api/users', (route) => {
    const users = fixture('users').map((u, i) =>
      u.email.endsWith('@example.com') ? u : { ...u, email: `member${i}@example.com`, display_name: `member${i}` },
    );
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(users) });
  });
  // 模擬考 fixture 的 running_since 是 null(暫停);拍「作答中」要把它接上現在。
  await ctx.route('**/api/exam/e2e-1/state', (route) => {
    const st = fixture('exam_e2e-1_state');
    st.running_since = Date.now() - 15_000;
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(st) });
  });
  // 講義閱讀器:list fixture 裡沒有對應的單筆端點與 PDF,照 lecture-bookmarks.test 補。
  const SLUG = 'lecture-e2e';
  const pdf = fs.readFileSync(path.join(FIXTURES, 'lecture-e2e.pdf'));
  const DOC = {
    slug: SLUG,
    title: '紅血球生成與貧血概論',
    sort_order: 1,
    r2_key: `lectures/${SLUG}.pdf`,
    page_count: 6,
    bytes: pdf.length,
    created_at: 1754000000000,
    anno_count: 0,
    note_count: 0,
    kind: 'lecture',
    pdf_url: `/lectures-pdf/${SLUG}.pdf`,
  };
  await ctx.route(`**/api/lectures/${SLUG}/bookmarks`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
  );
  await ctx.route(`**/api/lectures/${SLUG}`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(DOC) }),
  );
  await ctx.route(`**/lectures-pdf/${SLUG}.pdf`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/pdf', body: pdf }),
  );
  // 到期佇列:fixture 只有摘要,沒有 /due/next(回 {} 會畫成「今天做完了」)。用
  // 113-050 那題拼一份 AnkiQuestion,讓卡片真的長出來。
  await ctx.route('**/api/review/due/next**', (route) => {
    const q = fixture('questions_113-050');
    const summary = { ...fixture('review_due'), due_review: 12, learning: 2, due_total: 14 };
    const day = 86_400_000;
    const now = Date.now();
    const preview = {
      again: { due_at: now + 600_000, scheduled_days: 0, state: 3 },
      hard: { due_at: now + 2 * day, scheduled_days: 2, state: 2 },
      good: { due_at: now + 6 * day, scheduled_days: 6, state: 2 },
      easy: { due_at: now + 15 * day, scheduled_days: 15, state: 2 },
    };
    const question = {
      id: q.id, year: q.year, number: q.number, stem: q.stem, options: q.options, answer: q.answer,
      group: q.group, tags: q.tags ?? [], explanation: q.explanation ?? null,
      fsrs: { card: null, preview, retrievability: 0.82 },
    };
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ queue: summary, kind: 'review', question }),
    });
  });
  // 歷次全真:fixture 沒有 /api/exam 清單,用成績頁那一場加兩場拼出來。
  await ctx.route('**/api/exam', (route) => {
    const s = fixture('exam_e2e-1').session;
    const rows = [
      { ...s, id: 'e2e-3', year: 0, kind: 'custom', started_at: s.started_at + 5 * 86_400_000, finished_at: null, score: null, duration_sec: null },
      { ...s, id: 'e2e-2', year: 112, started_at: s.started_at + 2 * 86_400_000, finished_at: s.started_at + 2 * 86_400_000 + 5_400_000, score: 71, duration_sec: 5400 },
      { ...s, score: 62 },
    ];
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(rows) });
  });
  // 作答後的統計列:fixture 沒有 /stats(回 {} 會畫成「你 NaN 分 NaN 秒」)。
  await ctx.route('**/api/questions/113-050/stats', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        attempts: 18, correct: 11, responders: 16, accuracy: 61,
        my_elapsed_ms: 42_000, median_elapsed_ms: 55_000, p90_elapsed_ms: 98_000, timed_responders: 14,
        choices: { A: 3, B: 11, C: 1, D: 1 }, choice_pct: { A: 19, B: 69, C: 6, D: 6 },
        choice_responders: 16, choices_state: 'ok', my_choice: 'B',
      }),
    }),
  );
  if (loggedOut) {
    await ctx.route('**/api/me', (route) =>
      route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"unauthorized"}' }),
    );
  }
}

// ── 鏡頭清單 ────────────────────────────────────────────────────────────────
// 每一鏡:name(檔名)、path、wait(出現這段文字才算載好)、prepare(拍之前的互動)。
// desktop 1280×800,mobile 390×844。theme 預設 light。

const wait = (text) => async (page) => {
  await page.getByText(text, { exact: false }).first().waitFor({ timeout: 20_000 });
};

const STUDY_PLAN_ANSWERS = ['對,以系統紀錄為準', '就這些', '30 分鐘', '就用 85 秒', '3 輪', '4 場', '產生計畫'];

const SHOTS = [
  // 對外
  { name: 'landing', path: '/', loggedOut: true, ready: wait('登入') },
  { name: 'm-landing', path: '/', loggedOut: true, mobile: true, ready: wait('登入') },

  // 首頁
  { name: 'home-smear', path: '/', ready: wait('抹片') , settle: 1200 },
  { name: 'home-exam', path: '/?tab=exam', ready: wait('倒數'), settle: 1200 },
  { name: 'm-home', path: '/', mobile: true, ready: wait('複習模式'), settle: 1200 },
  {
    name: 'study-plan',
    path: '/?tab=exam',
    ready: wait('生成讀書計畫'),
    prepare: async (page) => {
      await page.getByRole('button', { name: '生成讀書計畫' }).click();
      const dialog = page.getByRole('dialog', { name: '生成讀書計畫' });
      await dialog.waitFor({ timeout: 10_000 });
      for (const label of STUDY_PLAN_ANSWERS) {
        const btn = dialog.getByRole('button', { name: label, exact: true });
        await btn.waitFor({ timeout: 10_000 });
        await btn.click();
      }
      await dialog.getByText('已排入題數').waitFor({ timeout: 10_000 });
    },
  },

  // 筆試:複習
  { name: 'review-index', path: '/review', ready: wait('民國') },
  { name: 'year-list', path: '/year/113', ready: wait('113') },
  { name: 'question', path: '/q/113-050', ready: wait('孟買血型'), settle: 1200 },
  {
    name: 'question-answered',
    path: '/q/113-050',
    ready: wait('孟買血型'),
    settle: 1000,
    prepare: async (page) => {
      await page.locator('li:visible').filter({ hasText: '亞孟買' }).first().click();
      await page.getByRole('button', { name: '提交答案' }).click();
      await page.waitForTimeout(900);
    },
  },
  {
    name: 'question-revealed',
    path: '/q/113-050',
    ready: wait('孟買血型'),
    settle: 1000,
    prepare: async (page) => {
      await page.locator('li:visible').filter({ hasText: '亞孟買' }).first().click();
      await page.getByRole('button', { name: '提交答案' }).click();
      await page.waitForTimeout(600);
      await page.locator('button:visible', { hasText: '點擊顯示詳解' }).first().click({ force: true });
      await page.waitForTimeout(900);
    },
  },
  { name: 'question-dark', path: '/q/113-050', theme: 'dark', ready: wait('孟買血型'), settle: 1200 },
  { name: 'question-eink', path: '/q/113-050', theme: 'eink', ready: wait('孟買血型'), settle: 1200 },
  { name: 'm-question', path: '/q/113-050', mobile: true, ready: wait('孟買血型'), settle: 1200 },
  {
    name: 'm-question-explanation',
    path: '/q/113-050',
    mobile: true,
    ready: wait('孟買血型'),
    prepare: async (page) => {
      const tab = page.getByRole('button', { name: /詳解/ }).first();
      if (await tab.count()) await tab.click();
      await page.waitForTimeout(900);
    },
  },
  { name: 'due', path: '/due', ready: wait('到期'), settle: 800 },
  { name: 'm-due', path: '/due', mobile: true, ready: wait('到期'), settle: 800 },
  { name: 'wrong', path: '/wrong', ready: wait('錯題'), settle: 800 },
  { name: 'search', path: '/search?q=白血病', ready: wait('白血病'), settle: 1000 },
  { name: 'weakness-map', path: '/weakness-map', ready: wait('弱點'), settle: 1200 },
  { name: 'bookmarks', path: '/bookmarks', ready: wait('收藏'), settle: 800 },
  { name: 'challenges', path: '/challenges', ready: wait('挑戰'), settle: 800 },

  // 筆試:全真
  { name: 'exam-running', path: '/exam/e2e-1', ready: wait('第 1 題'), settle: 1000 },
  { name: 'm-exam-running', path: '/exam/e2e-1', mobile: true, ready: wait('第 1 題'), settle: 1000 },
  {
    name: 'exam-submit-dialog',
    path: '/exam/e2e-1',
    ready: wait('第 1 題'),
    prepare: async (page) => {
      await page.getByRole('button', { name: /交卷/ }).first().click();
      await page.getByRole('dialog').waitFor({ timeout: 10_000 });
      await page.waitForTimeout(400);
    },
  },
  { name: 'exam-result', path: '/exam/e2e-1/result', ready: wait('第 1 題'), settle: 1200 },
  { name: 'custom-test', path: '/exam/new', ready: wait('題'), settle: 800 },
  { name: 'exam-history', path: '/exam-history', ready: wait('全真'), settle: 800 },

  // 抹片
  { name: 'smear-index', path: '/smear', ready: wait('抹片'), settle: 1000 },
  {
    name: 'smear-setup',
    path: '/smear',
    ready: wait('抹片'),
    prepare: async (page) => {
      // 複習模式現在是獨立的主題選擇頁(smear-review-topics 那一鏡);全真模式才開
      // 場設定 dialog。
      await page.getByRole('button', { name: '全真模式' }).click();
      await page.getByText('骨髓性').first().waitFor({ timeout: 10_000 });
      await page.waitForTimeout(400);
    },
  },
  { name: 'smear-review-topics', path: '/smear/review', ready: wait('主題'), settle: 1000 },
  { name: 'smear-session', path: '/smear/s/e2e-1', ready: wait('點擊放大'), settle: 1200 },
  { name: 'm-smear-session', path: '/smear/s/e2e-1', mobile: true, ready: wait('點擊放大'), settle: 1200 },
  {
    name: 'smear-graded',
    path: '/smear/s/e2e-1',
    ready: wait('點擊放大'),
    prepare: async (page) => {
      const input = page.locator('input[type="text"]:visible, input:not([type]):visible').first();
      await input.fill('pronormoblast');
      await page.getByRole('button', { name: '提交答案' }).click();
      await page.getByRole('button', { name: '下一題' }).waitFor({ timeout: 10_000 });
      await page.waitForTimeout(600);
    },
  },
  {
    name: 'm-smear-graded',
    path: '/smear/s/e2e-1',
    mobile: true,
    ready: wait('點擊放大'),
    prepare: async (page) => {
      const input = page.locator('input[type="text"]:visible, input:not([type]):visible').first();
      await input.fill('tear drop');
      await page.getByRole('button', { name: '提交答案' }).click();
      await page.getByRole('button', { name: '下一題' }).waitFor({ timeout: 10_000 });
      await page.waitForTimeout(600);
    },
  },
  { name: 'smear-result', path: '/smear/s/e2e-result/result', ready: wait('主題分類'), settle: 1200 },
  { name: 'm-smear-result', path: '/smear/s/e2e-result/result', mobile: true, ready: wait('主題分類'), settle: 1200 },
  { name: 'smear-dx', path: '/smear/dx/dacrocyte', ready: wait('dacryocyte'), settle: 1200 },
  {
    name: 'smear-search',
    path: '/smear?tab=search',
    ready: wait('輸入關鍵字開始搜尋診斷'),
    prepare: async (page) => {
      const input = page.locator('input:visible').first();
      await input.fill('dacro');
      await page.waitForTimeout(1500);
    },
  },
  { name: 'smear-history', path: '/smear?tab=history', ready: wait('未完成'), settle: 800 },

  // 閱讀輔助與其他
  { name: 'lectures', path: '/lectures', ready: wait('講義'), settle: 1000 },
  {
    name: 'lecture-reader',
    path: '/lectures/lecture-e2e',
    ready: wait('縮圖'),
    settle: 3500,
  },
  { name: 'notes', path: '/notes/n1', ready: wait('anthracycline'), settle: 1000 },
  { name: 'videos', path: '/videos', ready: wait('影片'), settle: 1000 },
  { name: 'profile', path: '/profile', ready: wait('801 筆'), settle: 1200 },
  { name: 'play', path: '/play', ready: wait('128'), settle: 800 },
];

// ── 主流程 ──────────────────────────────────────────────────────────────────
const server = await startServer({ dist: DIST });
const browser = await chromium.launch();
const results = [];
const failures = [];

try {
  for (const shot of SHOTS) {
    if (only && !only.some((o) => shot.name.includes(o))) continue;
    const mobile = !!shot.mobile;
    const ctx = await browser.newContext({
      viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 800 },
      deviceScaleFactor: mobile ? 2 : 1.5,
      isMobile: mobile,
      hasTouch: mobile,
      serviceWorkers: 'block',
      locale: 'zh-TW',
      timezoneId: 'Asia/Taipei',
      colorScheme: shot.theme === 'dark' ? 'dark' : 'light',
      reducedMotion: 'reduce',
    });
    await installRoutes(ctx, { loggedOut: !!shot.loggedOut });
    const theme = shot.theme ?? 'light';
    await ctx.addInitScript(
      ([k, v]) => {
        try {
          localStorage.setItem(k, v);
        } catch {}
      },
      [THEME_KEY, theme],
    );
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    const png = path.join(TMP, `${shot.name}.png`);
    try {
      await page.goto(server.origin + shot.path, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await shot.ready(page);
      if (shot.prepare) await shot.prepare(page);
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(shot.settle ?? 500);
      await page.screenshot({ path: png, fullPage: !!shot.fullPage });
      const out = toWebp(png, path.join(OUT, `${shot.name}.webp`));
      results.push({ name: shot.name, file: path.basename(out), mobile, theme, errors });
      console.log(`✓ ${shot.name}${errors.length ? `  (pageerror ×${errors.length})` : ''}`);
    } catch (e) {
      failures.push({ name: shot.name, error: String(e).split('\n')[0] });
      console.log(`✗ ${shot.name}: ${String(e).split('\n')[0]}`);
      await page.screenshot({ path: path.join(TMP, `${shot.name}.FAILED.png`) }).catch(() => {});
    } finally {
      await ctx.close();
    }
  }
} finally {
  await browser.close();
  await server.close();
}

function toWebp(png, webp) {
  try {
    execFileSync('cwebp', ['-quiet', '-q', '84', png, '-o', webp]);
    return webp;
  } catch {
    const fallback = webp.replace(/\.webp$/, '.png');
    fs.copyFileSync(png, fallback);
    return fallback;
  }
}

if (!only) {
  fs.writeFileSync(
    path.join(OUT, 'manifest.json'),
    JSON.stringify({ generated_at: new Date().toISOString(), shots: results, failures }, null, 2) + '\n',
  );
}
const missing = server.missingFixtures();
if (missing.length) console.log(`\n沒有 fixture 的端點(回 {}):\n  ${missing.join('\n  ')}`);
if (failures.length) {
  console.log(`\n失敗 ${failures.length} 鏡:`);
  for (const f of failures) console.log(`  ${f.name}: ${f.error}`);
  process.exitCode = 1;
}

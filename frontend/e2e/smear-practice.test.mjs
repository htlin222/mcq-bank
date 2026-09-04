// 抹片練習(/smear)的完整使用者旅程 —— 走一次真的會發生的互動,驗業務邏輯
// (判定/提示/成績逐主題拆分/全真模式全程不揭曉),不只是「有沒有炸」。
//
// 為什麼要多開這一支,而不是繼續依賴 D1-D6 各自加的散裝覆蓋:
//   - smoke.test.mjs 只斷言「渲染出東西、沒有 pageerror」—— 對 /smear/s/e2e-1
//     跟 /smear/dx/dacrocyte 都只是這樣,抓不到「lay tier 被誤判成 miss」或
//     「全真模式提早洩漏正解」這種業務邏輯錯誤。
//   - eink.test.mjs 只掃顏色安全,不驗任何數字或文字內容對不對。
//   - smear-answer-overflow.test.mjs 只驗一個手機版面的溢出回歸,不是完整旅程。
//   - 個別 PR 的 reviewer 用 ad-hoc Playwright session 手動驗過「作答會不會
//     顯示對勾」「全真模式交卷前是不是真的什麼都看不到」,但那些驗證從來沒有
//     被寫成回歸測試 —— 這支補的就是那個缺口。
//
// fixture 策略:不是靜態 JSON 檔,是 ctx.route 掛一個小型狀態機模擬
// worker/routes/smear.ts 的真實行為(exam 模式的 opaque `#idx`、revealGrade
// 閘、finish 對未作答題目的 miss 預設)。純靜態 fixture 撐不住「連續作答 +
// 交卷 + 回顧」這種跨請求要前後一致的流程 —— 見 CLAUDE.md 對「fixture drift」
// 的警告:發文分數項的判定,不能自己憑空編,得跟 worker/lib/smear-grade.ts
// 的演算法真的對得上,見下面 gradeFor() 的推導。
//
// dx 資料(canonical/terms)直接取自 scripts/smear/data/dx.json 的真實項目
// (hairy_cell_leukemia / dacrocyte / apl / pll / acanthocytosis),不是憑空
// 編造 —— 這樣「lay tier 打進去真的會判 lay」不是我說了算,是題庫本來就這樣定義。
//
//   pnpm test:webkit
//
// 沒安裝 playwright / webkit 時預設跳過;CI 設 E2E_REQUIRE=1 改為失敗。

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

// ---------------------------------------------------------------------------
// 診斷資料 —— 逐字取自 scripts/smear/data/dx.json,不是自己編的。
// ---------------------------------------------------------------------------
const DX = {
  hairy_cell_leukemia: {
    dx_id: 'hairy_cell_leukemia',
    canonical_long: 'hairy cell leukemia',
    topic: 'lymphoid',
    qtype: 'disease',
    terms: [
      { text: 'hair cell leukemia', tier: 'full' },
      { text: 'hairy cell leukemia', tier: 'full' },
      { text: 'HCL', tier: 'full' },
      { text: 'hairy cell', tier: 'full' },
    ],
  },
  dacrocyte: {
    dx_id: 'dacrocyte',
    canonical_long: 'Dacrocyte',
    topic: 'rbc',
    qtype: 'cell',
    terms: [
      { text: 'dacrocyte', tier: 'full' },
      { text: 'dacryocyte', tier: 'full' },
      { text: 'teardrop cell', tier: 'lay' },
      { text: 'tear drop', tier: 'lay' },
    ],
  },
  apl: {
    dx_id: 'apl',
    canonical_long: 'acute promyelocytic leukemia',
    topic: 'myeloid',
    qtype: 'disease',
    terms: [
      { text: 'APML', tier: 'full' },
      { text: 'APL', tier: 'full' },
      { text: 'acute promyelocytic leukemia', tier: 'full' },
      { text: 'AML', tier: 'half' },
      { text: 'APML, M3', tier: 'full' },
      { text: 'AML, M3', tier: 'full' },
    ],
  },
  pll: {
    dx_id: 'pll',
    canonical_long: 'Prolymphocytic leukemia',
    topic: 'lymphoid',
    qtype: 'disease',
    terms: [
      { text: 'Prolymphocytic leukemia', tier: 'full' },
      { text: 'PLL', tier: 'full' },
      { text: 'Lymphoma', tier: 'half' },
    ],
  },
  acanthocytosis: {
    dx_id: 'acanthocytosis',
    canonical_long: 'acanthocytosis',
    topic: 'rbc',
    qtype: 'cell',
    terms: [
      { text: 'acanthocytosis', tier: 'full' },
      { text: 'acanthocyte', tier: 'full' },
      { text: 'spur cell', tier: 'lay' },
    ],
  },
};

function question(id, dx) {
  return {
    id,
    dx_id: dx.dx_id,
    source: 'exam',
    image_key_view: `smear/exam/${id}-view.webp`,
    image_key_full: `smear/exam/${id}-full.webp`,
    prompt: null,
    image_note: null,
    topic: dx.topic,
    qtype: dx.qtype,
    canonical_long: dx.canonical_long,
    terms: dx.terms,
  };
}

const META_FIXTURE = {
  dxCount: 103,
  topicWeights: {
    myeloid: 0.2,
    lymphoid: 0.2,
    normal_reactive: 0.15,
    rbc: 0.2,
    platelet: 0.1,
    infection: 0.1,
    other: 0.05,
  },
  sourceCounts: { exam: 700, ash: 274, po: 30 },
  topics: ['myeloid', 'lymphoid', 'normal_reactive', 'rbc', 'platelet', 'infection', 'other'],
};

function norm(s) {
  return String(s).toLowerCase().trim().replace(/\s+/g, ' ');
}

// 精確比對版的 gradeSmear —— 測試裡只會鍵入題庫定義好的 accepted term 本身
// (不測拼字容錯路徑,那是 worker/lib/smear-grade.test.ts 的事),所以完全
// 相符的比對已經跟真正的演算法在這幾個案例上結果一致(見檔頭手算過的推導)。
function gradeFor(q, typedRaw) {
  const typed = norm(typedRaw);
  for (const tier of ['full', 'half', 'lay']) {
    for (const t of q.terms.filter((t) => t.tier === tier)) {
      if (norm(t.text) === typed) {
        return {
          tier,
          score: { full: 1, half: 0.5, lay: 0 }[tier],
          matched: t.text,
          canonical: q.canonical_long,
          spellingErrors: [],
        };
      }
    }
  }
  return { tier: 'miss', score: 0, matched: null, canonical: q.canonical_long, spellingErrors: [] };
}

function resolveIdx(questions, questionId) {
  const direct = questions.findIndex((q) => q.id === questionId);
  if (direct >= 0) return direct;
  const m = /^#(\d+)$/.exec(questionId);
  if (m) return Number(m[1]);
  return -1;
}

/**
 * 掛一個貼齊 worker/routes/smear.ts 真實行為的小型後端模擬:
 *   - exam 模式在 finish 之前,問題 id 是 opaque 的 `#idx`(clientQuestionId)
 *   - my_tier/my_score/dx_id 只有 revealGrade(review 模式,或已 finish)才給
 *   - finish 對沒作答的題目補 tier='miss' / score=0(同 worker 的預設邏輯)
 *
 * 讓 mock 假裝成不同形狀很容易寫出「測試綠了但什麼都沒測到」的假陽性
 * (CLAUDE.md 講的 fixture drift),所以這裡刻意鏡射 worker 端的欄位閘,而
 * 不是自己另外發明一套更方便測的形狀。
 */
function installSmearBackend(ctx, { mode, questions, sessionId, leakExamAnswer = false }) {
  const state = {
    mode,
    questions,
    finished: false,
    startedAt: Date.now(),
    finishedAt: null,
    answers: new Map(),
  };
  const calls = { create: [], answer: [], answerResponses: [], finishCount: 0 };

  const pathRe = new RegExp(`^/api/smear/sessions/${sessionId}(?:/(answer|finish))?$`);

  ctx.route('**/api/smear/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname;
    const method = req.method();
    const json = (body, status = 200) =>
      route.fulfill({
        status,
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify(body),
      });

    if (p === '/api/smear/meta' && method === 'GET') {
      return json(META_FIXTURE);
    }

    if (p === '/api/smear/sessions' && method === 'POST') {
      const body = JSON.parse(req.postData() || '{}');
      calls.create.push(body);
      const revealed = state.mode === 'review';
      return json({
        id: sessionId,
        question_ids: state.questions.map((q, i) => (revealed ? q.id : `#${i}`)),
      });
    }

    const m = p.match(pathRe);
    if (!m) return json({});
    const sub = m[1];
    const revealGrade = state.mode === 'review' || state.finished;

    if (!sub && method === 'GET') {
      return json({
        id: sessionId,
        mode: state.mode,
        config: { mode: state.mode, n: state.questions.length, form: 'any' },
        started_at: state.startedAt,
        finished_at: state.finished ? state.finishedAt : null,
        questions: state.questions.map((q, i) => {
          const a = state.answers.get(q.id);
          return {
            id: revealGrade ? q.id : `#${i}`,
            dx_id: revealGrade ? q.dx_id : undefined,
            source: q.source,
            image_key_view: q.image_key_view,
            image_key_full: q.image_key_full,
            prompt: q.prompt,
            image_note: q.image_note,
            topic: q.topic,
            qtype: q.qtype,
            answered: !!a,
            my_tier: revealGrade ? (a?.tier ?? undefined) : undefined,
            my_score: revealGrade ? (a?.score ?? undefined) : undefined,
          };
        }),
      });
    }

    if (sub === 'answer' && method === 'POST') {
      const body = JSON.parse(req.postData() || '{}');
      calls.answer.push(body);
      const idx = resolveIdx(state.questions, body.questionId);
      const q = state.questions[idx];
      const g = gradeFor(q, (body.boxes || [])[0] || '');
      state.answers.set(q.id, { ...g, typed: body.boxes });

      // leakExamAnswer 只給「驗證這支測試真的抓得到迴歸」那段用 —— 正常情況
      // 下 exam 模式永遠只回 {ok:true},見 worker/routes/smear.ts 的檔頭註解。
      const resBody =
        state.mode === 'review' || leakExamAnswer
          ? {
              tier: g.tier,
              score: g.score,
              matched: g.matched,
              canonical: g.canonical,
              spellingErrors: g.spellingErrors,
              acceptedTerms: q.terms,
            }
          : { ok: true };
      calls.answerResponses.push(resBody);
      return json(resBody);
    }

    if (sub === 'finish' && method === 'POST') {
      calls.finishCount++;
      if (!state.finished) {
        state.finished = true;
        state.finishedAt = Date.now();
      }
      let score = 0;
      let spellingOk = 0;
      let layCount = 0;
      const breakdown = state.questions.map((q) => {
        const a = state.answers.get(q.id);
        const tier = a?.tier ?? 'miss';
        const s = a?.score ?? 0;
        score += s;
        if (tier === 'full' && (a?.spellingErrors?.length ?? 0) === 0) spellingOk++;
        if (tier === 'lay') layCount++;
        return {
          question_id: q.id,
          dx_id: q.dx_id,
          canonical_long: q.canonical_long,
          topic: q.topic,
          typed: a?.typed ?? [],
          tier,
          score: s,
          spelling_errors: a?.spellingErrors ?? [],
        };
      });
      return json({
        score,
        max_score: state.questions.length,
        spelling_ok: spellingOk,
        lay_count: layCount,
        question_count: state.questions.length,
        breakdown,
      });
    }

    return json({});
  });

  return { calls };
}

async function overflow(page) {
  return page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
}

function assertNoOverflow(box, where) {
  assert.ok(
    box.scrollWidth <= box.clientWidth + 1,
    `${where} 把頁面撐寬了:scrollWidth=${box.scrollWidth} clientWidth=${box.clientWidth}`,
  );
}

// ---------------------------------------------------------------------------
// 測試 1 —— 複習模式:完整走一場,判定/提示/成績逐主題拆分都要對得上
// ---------------------------------------------------------------------------
test('複習模式:作答判定、俗名 tier 跟 miss 不同、提示只揭曉分類、成績逐主題拆分正確', async (t) => {
  if (guard(t)) return;
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
  const questions = [
    question('rev-q1', DX.hairy_cell_leukemia), // lymphoid,全對
    question('rev-q2', DX.dacrocyte), // rbc,俗名(lay,0 分但不是 miss)
    question('rev-q3', DX.apl), // myeloid,用提示再全對
  ];
  const { calls } = installSmearBackend(ctx, { mode: 'review', questions, sessionId: 'rev-sess' });

  try {
    const page = await ctx.newPage();
    await page.goto(`${server.origin}/smear`, { waitUntil: 'domcontentloaded' });

    await page.getByRole('button', { name: '複習模式' }).click();
    // 空掃防線:主題篩選要真的載入了(GET /api/smear/meta 回來了),否則後面
    // 「開始練習」按鈕全程是 disabled,點下去什麼都不會發生。
    await page.getByText('骨髓性').first().waitFor({ timeout: 10_000 });
    await page.getByLabel('題數').fill('5'); // StartDialog 限制題數下限是 5(MIN_N),即使 mock 只會回 3 題
    await page.getByRole('button', { name: '開始練習' }).click();
    await page.waitForURL('**/smear/s/rev-sess', { timeout: 20_000 });

    const input = page.getByPlaceholder('輸入診斷或細胞名稱…');
    const reveal = page.locator('[data-testid="grade-reveal"]');

    // ── Q1:完全正確 ──────────────────────────────────────────────
    await input.waitFor();
    assert.equal(await reveal.count(), 0, '作答前不該有判定畫面');
    await input.fill('hairy cell leukemia');
    await page.getByRole('button', { name: '提交答案' }).click();
    await reveal.waitFor();
    const t1 = await reveal.innerText();
    assert.match(t1, /完全正確/, '全對應該顯示「完全正確」');
    assert.match(t1, /\+1 分/, '全對應該是 +1 分');
    await page.getByRole('button', { name: '下一題' }).click();

    // ── Q2:俗名(lay tier)—— 0 分,但不是「未命中」,且正解要照樣顯示 ──
    await input.waitFor();
    await input.fill('tear drop');
    await page.getByRole('button', { name: '提交答案' }).click();
    await reveal.waitFor();
    const t2 = await reveal.innerText();
    assert.match(t2, /俗名用法/, '俗名寫法應該顯示「俗名用法(不計分)」');
    assert.doesNotMatch(t2, /未命中/, 'lay tier 不該被畫成跟真的沒命中一樣');
    assert.match(t2, /\+0 分/, '俗名不計分,應該是 +0 分');
    assert.match(t2, /正解[:：]/, '即使 0 分,俗名寫法也該照樣秀出正解');
    assert.match(t2, /Dacrocyte/, '正解文字應該是這題真正的診斷全名');
    await page.getByRole('button', { name: '下一題' }).click();

    // ── Q3:先用提示,確認只揭曉分類、不揭曉正解 ──────────────────────
    await input.waitFor();
    const beforeHint = await page.locator('body').innerText();
    assert.ok(
      !beforeHint.includes('acute promyelocytic leukemia'),
      '還沒作答、還沒按提示,正解不該出現在畫面上',
    );
    await page.getByRole('button', { name: '提示' }).click();
    const afterHint = await page.locator('body').innerText();
    assert.match(afterHint, /分類提示[:：]\s*骨髓性/, '提示應該揭曉分類');
    assert.ok(
      !afterHint.includes('acute promyelocytic leukemia') && !afterHint.includes('APL'),
      '提示只能揭曉分類,不能連正解一起漏',
    );
    assert.equal(
      await page.getByRole('button', { name: '提示' }).count(),
      0,
      '按過一次提示之後,提示鈕應該收起來(不能重複宣告用了提示)',
    );
    await input.fill('APL');
    await page.getByRole('button', { name: '提交答案' }).click();
    await reveal.waitFor();

    // 用了提示的請求要帶 hintUsed,沒用的不該帶 —— 這是唯一能觀察到
    // hint_used 有沒有被正確記錄的地方(前端從未在畫面上把它秀出來,
    // 見 smearApi.ts 的型別註解)。
    assert.equal(calls.answer.length, 3);
    assert.equal(calls.answer[0].hintUsed, undefined, 'Q1 沒用提示');
    assert.equal(calls.answer[1].hintUsed, undefined, 'Q2 沒用提示');
    assert.equal(calls.answer[2].hintUsed, 'topic', 'Q3 用了提示,要記錄下來');

    await page.getByRole('button', { name: '查看成績' }).click();
    await page.waitForURL('**/smear/s/rev-sess/result', { timeout: 20_000 });
    // 這一頁先打 GET /sessions/:id、再打 finish、可能再打一次 GET —— 讀畫面
    // 文字前要等它真的落地,否則量到的是「載入中…」而不是成績頁本身。
    await page.getByText('主題分類').waitFor({ timeout: 20_000 });

    // ── 成績頁:總分 2/3(1 + 0 + 1),逐主題正確反映各自的答題結果 ──────
    const bodyText = await page.locator('body').innerText();
    assert.match(bodyText, /2\s*\/\s*3/, '總分應該是 2/3');
    assert.match(bodyText, /67%/, '2/3 四捨五入應該是 67%');
    assert.match(bodyText, /拼字完全正確[:：]\s*2\s*題/, 'Q1、Q3 全對且沒有拼字錯誤');
    assert.match(bodyText, /用了俗名[:：]\s*1\s*題/, '只有 Q2 是俗名');

    const lymphBar = page.getByRole('progressbar', { name: '淋巴性 正確率' });
    const rbcBar = page.getByRole('progressbar', { name: '紅血球系 正確率' });
    const myeloidBar = page.getByRole('progressbar', { name: '骨髓性 正確率' });
    await lymphBar.waitFor();
    assert.equal(await lymphBar.getAttribute('aria-valuenow'), '100', '淋巴性只有 Q1,全對');
    assert.equal(await rbcBar.getAttribute('aria-valuenow'), '0', '紅血球系只有 Q2,俗名不計分');
    assert.equal(await myeloidBar.getAttribute('aria-valuenow'), '100', '骨髓性只有 Q3,全對');
    assert.match(await lymphBar.locator('..').innerText(), /1\/1/);
    assert.match(await rbcBar.locator('..').innerText(), /0\/1/);
    assert.match(await myeloidBar.locator('..').innerText(), /1\/1/);
  } finally {
    await ctx.close();
  }
});

// ---------------------------------------------------------------------------
// 測試 2 —— 全真模式:交卷前全程不揭曉,交卷後才看得到完整判定
// ---------------------------------------------------------------------------
test('全真模式:交卷前頁面上找不到任何一個正解字串,交卷後逐題檢討才揭曉', async (t) => {
  if (guard(t)) return;
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });

  const questions = [
    question('exam-q1', DX.apl), // 會答對(full)
    question('exam-q2', DX.pll), // 會答半分(half)
    question('exam-q3', DX.dacrocyte), // 不作答 —— finish 時應該補 miss
    question('exam-q4', DX.hairy_cell_leukemia), // 不作答
    question('exam-q5', DX.acanthocytosis), // 不作答
  ];
  const { calls } = installSmearBackend(ctx, { mode: 'exam', questions, sessionId: 'exam-sess' });

  // 交卷前不該出現在畫面上的任何字串:五題的正解全文、判定標籤、分數符號。
  const FORBIDDEN = [
    'acute promyelocytic leukemia',
    'APL',
    'APML',
    'Prolymphocytic leukemia',
    'PLL',
    'Lymphoma',
    'Dacrocyte',
    'dacryocyte',
    'teardrop cell',
    'tear drop',
    'hairy cell leukemia',
    'HCL',
    'acanthocytosis',
    'acanthocyte',
    'spur cell',
    '完全正確',
    '部分正確',
    '俗名用法',
    '未命中',
    '正解',
  ];
  async function assertNoLeakage(page, where) {
    const text = await page.locator('body').innerText();
    for (const s of FORBIDDEN) {
      assert.ok(!text.includes(s), `${where}:全真模式交卷前不該出現「${s}」`);
    }
  }

  try {
    const page = await ctx.newPage();
    await page.goto(`${server.origin}/smear`, { waitUntil: 'domcontentloaded' });

    await page.getByRole('button', { name: '全真模式' }).click();
    await page.getByText('骨髓性').first().waitFor({ timeout: 10_000 });
    await page.getByLabel('題數').fill('5');
    await page.getByRole('button', { name: '開始練習' }).click();
    await page.waitForURL('**/smear/s/exam-sess', { timeout: 20_000 });

    const input = page.getByPlaceholder('輸入診斷或細胞名稱…');

    await input.waitFor();
    await assertNoLeakage(page, '一開始(尚未作答第一題)');

    // Q1
    await input.fill('acute promyelocytic leukemia');
    await page.getByRole('button', { name: '提交答案' }).click();
    await page.locator('text=全真模式全程不揭曉判定').waitFor();
    await assertNoLeakage(page, '答完 Q1 之後');
    await page.getByRole('button', { name: '下一題' }).click();

    // Q2
    await input.waitFor();
    await input.fill('Lymphoma');
    await page.getByRole('button', { name: '提交答案' }).click();
    await page.locator('text=全真模式全程不揭曉判定').waitFor();
    await assertNoLeakage(page, '答完 Q2 之後');

    // 回頭看 Q1 —— 已作答的題目重新顯示,也不該洩漏判定。
    await page.getByRole('button', { name: '上一題' }).click();
    await page.locator('text=全真模式全程不揭曉判定').waitFor();
    await assertNoLeakage(page, '回頭查看已作答的 Q1');
    await page.getByRole('button', { name: '下一題' }).click();
    await page.locator('text=全真模式全程不揭曉判定').waitFor();

    // 只答了 2/5 題就提前結束 —— 走原生 confirm。
    page.once('dialog', (d) => d.accept());
    await page.getByRole('button', { name: '提前結束' }).click();
    await page.waitForURL('**/smear/s/exam-sess/result', { timeout: 20_000 });
    await page.getByText('逐題檢討').waitFor({ timeout: 20_000 });

    // ── 交卷後:完整揭曉,而且數字要對得上「2 題有答、3 題沒答」 ──────────
    const bodyText = await page.locator('body').innerText();
    assert.match(bodyText, /1\.5\s*\/\s*5/, '1(full) + 0.5(half) + 0+0+0(miss) = 1.5/5');
    assert.match(bodyText, /30%/, '1.5/5 = 30%');
    assert.ok(bodyText.includes('acute promyelocytic leukemia'), '交卷後 Q1 正解應該揭曉');
    assert.ok(bodyText.includes('Prolymphocytic leukemia'), '交卷後 Q2 正解應該揭曉');
    assert.ok(bodyText.includes('Dacrocyte'), '交卷後未作答的 Q3 也要揭曉正解(miss,不是留白)');
    assert.match(bodyText, /完全正確/, 'Q1 應該標成完全正確');
    assert.match(bodyText, /部分正確/, 'Q2 應該標成部分正確(半分)');
    assert.match(bodyText, /未命中/, '3、4、5 題沒作答,finish 端要補成 miss');
    assert.match(bodyText, /未作答/, '沒作答的題目,作答內容欄要顯示「(未作答)」而不是空白');

    // 全真模式在交卷前,伺服器端回應本身也不能帶判定 —— 這條直接檢查
    // 攔截到的網路回應,而不是只看畫面渲染出來的結果。
    for (const res of calls.answerResponses) {
      assert.deepEqual(res, { ok: true }, '全真模式作答的回應不該帶 tier/score/canonical');
    }
  } finally {
    await ctx.close();
  }
});

// ---------------------------------------------------------------------------
// 測試 2b —— 驗證上面那支「不洩漏」測試真的抓得到迴歸,不是空掃的綠燈。
//
// 手法:把 mock 後端改成模擬「全真模式 answer 端點退化成跟 review 模式一樣
// 回完整判定」這個假設性的伺服器端迴歸,確認同一組畫面斷言真的會變紅。
// 這不是測試 app 程式碼(mock 是我們自己寫的),而是證明 FORBIDDEN 字串掃描
// 這個技巧本身有效 —— 見 CLAUDE.md 反覆講的「先證明對照組會失敗,斷言才有
// 意義」。
// ---------------------------------------------------------------------------
test('（自我驗證)若 exam 模式的 answer 回應意外帶了判定,畫面掃描要抓得到', async (t) => {
  if (guard(t)) return;
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
  const questions = [question('leak-q1', DX.apl)];
  installSmearBackend(ctx, {
    mode: 'exam',
    questions,
    sessionId: 'leak-sess',
    leakExamAnswer: true, // 刻意注入迴歸
  });

  try {
    const page = await ctx.newPage();
    await page.goto(`${server.origin}/smear`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: '全真模式' }).click();
    await page.getByText('骨髓性').first().waitFor({ timeout: 10_000 });
    await page.getByLabel('題數').fill('5');
    await page.getByRole('button', { name: '開始練習' }).click();
    await page.waitForURL('**/smear/s/leak-sess', { timeout: 20_000 });

    await page.getByPlaceholder('輸入診斷或細胞名稱…').fill('acute promyelocytic leukemia');
    await page.getByRole('button', { name: '提交答案' }).click();

    // 前端目前完全不去讀回應裡多出來的欄位(exam 模式 UI 是寫死的中性文字,
    // 不管伺服器回什麼),所以就算後端洩漏了,畫面上仍然只會顯示中性訊息。
    // 這正是為什麼測試 2 的「掃描畫面文字」對「前端有沒有把資料畫出來」是
    // 有效的護欄,但對「伺服器回應本身有沒有洩漏」需要另一道防線 ——
    // 於是測試 2 額外直接檢查 calls.answerResponses,而不是只信任畫面掃描。
    // 這支測試把那個推理寫下來,而不是留成一句沒人驗證過的假設。
    await page.locator('text=全真模式全程不揭曉判定').waitFor();
    const text = await page.locator('body').innerText();
    assert.ok(
      !text.includes('acute promyelocytic leukemia'),
      '前端沒有使用洩漏出來的欄位,畫面掃描不該紅 —— 這正是為什麼測試 2 還另外查了網路回應本身',
    );
  } finally {
    await ctx.close();
  }
});

// ---------------------------------------------------------------------------
// 測試 3 —— 手機版面(390px):同一段複習模式旅程,每個關鍵步驟都不能橫向溢出
// ---------------------------------------------------------------------------
test('390px:複習模式從開始練習到成績頁,每個關鍵步驟都不會橫向溢出', async (t) => {
  if (guard(t)) return;
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  const questions = [question('mob-q1', DX.hairy_cell_leukemia), question('mob-q2', DX.dacrocyte)];
  installSmearBackend(ctx, { mode: 'review', questions, sessionId: 'mob-sess' });

  try {
    const page = await ctx.newPage();
    await page.goto(`${server.origin}/smear`, { waitUntil: 'domcontentloaded' });
    assertNoOverflow(await overflow(page), '390px:抹片練習首頁');

    await page.getByRole('button', { name: '複習模式' }).click();
    await page.getByText('骨髓性').first().waitFor({ timeout: 10_000 });
    assertNoOverflow(await overflow(page), '390px:開始練習對話框');

    await page.getByLabel('題數').fill('5'); // StartDialog 限制題數下限是 5(MIN_N),即使 mock 只會回 2 題
    await page.getByRole('button', { name: '開始練習' }).click();
    await page.waitForURL('**/smear/s/mob-sess', { timeout: 20_000 });

    const input = page.getByPlaceholder('輸入診斷或細胞名稱…');
    await input.waitFor();
    assertNoOverflow(await overflow(page), '390px:作答頁(輸入前)');

    await input.fill('hairy cell leukemia');
    await page.getByRole('button', { name: '提交答案' }).click();
    await page.locator('[data-testid="grade-reveal"]').waitFor();
    assertNoOverflow(await overflow(page), '390px:判定畫面(全對)');
    await page.getByRole('button', { name: '下一題' }).click();

    await input.waitFor();
    await input.fill('tear drop');
    await page.getByRole('button', { name: '提交答案' }).click();
    await page.locator('[data-testid="grade-reveal"]').waitFor();
    assertNoOverflow(await overflow(page), '390px:判定畫面(俗名 + 正解文字)');

    await page.getByRole('button', { name: '查看成績' }).click();
    await page.waitForURL('**/smear/s/mob-sess/result', { timeout: 20_000 });
    await page.getByText('主題分類').waitFor();
    assertNoOverflow(await overflow(page), '390px:成績頁(含逐主題長條 + 逐題檢討)');
  } finally {
    await ctx.close();
  }
});

# 每題作答時間與配速報告 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 讓每一次作答都留下「這題花了多久」,並據此產出配速報告 —— 單題耗時 vs 全體中位數、模擬考檢討頁的每題耗時欄、以及 session 級「前 25 題 vs 後 25 題」的崩盤診斷。順帶補上目前完全缺失的**逐次作答歷史 `attempts`**,把聚合表從唯一真相降級為快取。

**Architecture:** 新增 append-only 的 `attempts` 表當作作答事件流(event log),既有 `review_progress` 的 `times_seen / times_correct / last_*` 保持雙寫、定位成 derived cache;`exam_answers` 仍是模擬考的「當前作答狀態」(可覆寫),但每次寫入額外 append 一筆 `attempts`。前端把單題計時抽成純函式 `questionTimer.ts`(`visibilitychange` 暫停、上限截斷),`elapsed_ms` 以 optional 欄位隨作答 POST 上去;伺服器夾值後入庫。配速統計(中位數/百分位/前後半段)全部走純函式 `worker/lib/pacing.ts`。

**Tech Stack:** Cloudflare Workers (Hono) + D1 (SQLite);前端 React 18 + Vite + TypeScript。測試 `node:test` + `node:assert/strict`,worker 側 `pnpm test`(`node --test 'worker/**/*.test.ts'`),前端純函式測試同目錄 `*.test.ts`、以 `node --test --experimental-strip-types` 跑(`frontend/tsconfig.json:24` 已 `exclude` 掉 `src/**/*.test.ts`,不會進 build)。

**為什麼值得做:** 國考 100 題定時(`worker/routes/exam.ts:10` 的 `MS_PER_QUESTION = 60 * 1000`,cap 由題數推導)。配速是少數「可訓練、且直接換分」的技能:知道自己哪一類題會超時、後 25 題是否崩盤,比再多做 50 題更有效。目前系統完全沒有這個訊號。

---

## 現況(file:line 佐證)

**只有 session 級計時,沒有題級計時。**

- `migrations/0007_exam_pause.sql:17-18` 為 `exam_sessions` 加了 `elapsed_ms` / `running_since`;`migrations/0010_exam_cap_ms.sql:12` 加 `cap_ms`。時間模型是 `live = elapsed_ms + (running_since ? now - running_since : 0)`,見 `worker/routes/exam.ts:132-134`、`worker/routes/exam.ts:284-287`。
- 暫停/恢復在 `worker/routes/exam.ts:153-212`,finish 時 `Math.min(liveElapsed, cap_ms)` 夾值(`worker/routes/exam.ts:287`)。**這是整個系統唯一的時間資料**。
- `exam_answers`(`migrations/0001_initial_schema.sql:118-125`)只有 `chosen / is_correct / answered_at`,主鍵 `(session_id, question_id)` —— 同一題重複作答會**覆寫**(`worker/routes/exam.ts:232-239`),沒有「第幾次、花多久」。`answered_at` 是「最後一次點選的時刻」,不是耗時。
- `review_progress`(`migrations/0001_initial_schema.sql:128-138`)只有聚合值 `times_seen / times_correct / last_seen_at / last_chosen / last_correct`,由 `answerProgressOp()`(`worker/routes/review.ts:101-133`)以 UPSERT 累加。**沒有時間序列**:無法回溯學習曲線、無法知道第 3 次答對是花 10 秒還是 3 分鐘。
- 下游全部只能吃聚合值:`GET /stats`(`worker/routes/review.ts:559-591`)、`GET /heatmap`(`worker/routes/review.ts:307-336`,用 `last_seen_at` 當「那天做過題」的近似,一天答 10 題只會算 1 次)、`GET /weakness-map`(`worker/routes/review.ts:212-272`)、`GET /wrong`(`worker/routes/review.ts:594-649`)、以及題目匿名統計 `GET /:id/stats`(`worker/routes/questions.ts:453-472`)。
- 唯一存在的逐次紀錄是 `fsrs_review_logs`(`migrations/0012_fsrs_anki.sql:35-52`),但那只涵蓋 Anki 模式的 rating,沒有 MCQ 選項、沒有耗時,而且 `POST /anki/review`(`worker/routes/review.ts:431-556`)只有在 `chosen` 有帶時才順便寫 `review_progress`。
- `confidence_events`(`migrations/0020_answer_confidence.sql`)是離最接近的先例:每次作答 append 一筆 `{confidence, is_correct, at}`,由 `worker/routes/review.ts:164-171` 寫入 —— 但它刻意不含 `chosen`、不含 source、也沒有耗時。
- 前端:模擬考 `frontend/src/routes/Exam.tsx:307-318` 的 `choose()` 只 debounce 400ms 送 `{question_id, chosen}`;複習模式 `frontend/src/components/QuestionCard.tsx:65-78` 的 `submit()` 送 `{question_id, chosen, confidence}`。**兩邊都沒有任何 timer**。檢討頁 `frontend/src/routes/ExamResult.tsx:15-22` 的 `answers` 型別也沒有耗時欄位。

---

## 非目標

- **不做**即時「你已經在這題卡了 90 秒」的焦慮提示(可留待後續,本計畫只做事後報告)。
- **不改** FSRS 排程演算法,也不把 `elapsed_ms` 餵進 FSRS(ts-fsrs 的 duration 欄位本計畫不啟用)。
- **不做** `attempts` 的一次性歷史回填(見「風險與回滾」的理由)。
- **不移除** `review_progress` / `exam_answers` 的任何欄位;本計畫只新增讀取來源。
- **不做**跨使用者的個人化配速排行榜(20 人,會變成點名)。

---

## 跨切面約定

- Auth 一律 `c.var.email`(Cloudflare Access 已驗過 JWT),路由內不做任何 app 級身分邏輯。
- migration **只新增不改已套用的**。目前最後一支是 `migrations/0022_highlights.sql`,故本計畫用 **0023**;實作前先 `ls migrations/ | tail -3` 重新確認號碼未被佔用。
- 純函式優先抽出、先寫失敗測試;worker 側測試放 `worker/lib/*.test.ts`,前端放 `frontend/src/lib/*.test.ts`。
- UI 沿用 scholarly/editorial 語氣:ink/cream + accent(`#a8442a`,`frontend/tailwind.config.js:20-24`,只有 `DEFAULT/dark/light` 三階,**不要**寫 `accent-500` 之類不存在的 class)。
- 全部落在 Cloudflare free tier,不新增付費服務。
- 每個 task 結束就 commit,可獨立回滾。

---

## Task 1.1: migration 0023 — `attempts` 事件表

**Files:** Create: `migrations/0023_attempts.sql`

**職責切分(寫進 migration 註解,避免第二個真相來源):**

| 表                  | 定位                                                                                                                                               | 本計畫後                      |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| `attempts`          | **唯一真相**:每次作答一列,append-only,不 UPDATE                                                                                                    | 新增                          |
| `review_progress`   | derived cache(聚合 + bookmark)。`times_seen/times_correct/last_*` 皆可由 `attempts` 重算;`bookmarked/bookmark_folder_id` **不是** derived,仍是真相 | 繼續雙寫,不動 schema          |
| `exam_answers`      | 模擬考「當前作答狀態」(可覆寫、供 resume 與計分),不是歷史                                                                                          | 繼續寫,額外 append `attempts` |
| `confidence_events` | 信心事件流。與 `attempts` 概念重疊但欄位不同;本計畫**不合併**(合併需改 `/calibration` 且無立即好處),留待後續以 `attempts.id` 外鍵收斂              | 不動                          |
| `fsrs_review_logs`  | FSRS 排程審計軌跡(rating/stability/due),與 MCQ 作答正交                                                                                            | 不動                          |

**雙寫期限:** `review_progress` 的聚合欄位維持雙寫,**期限為永久**(它同時承載 bookmark,無法整表退役)。但新功能一律讀 `attempts`;若日後發現兩邊漂移,以 `attempts` 重算覆蓋 `review_progress`(Task 4.3 附對帳查詢)。

**Step 1** — 建立 `migrations/0023_attempts.sql`:

```sql
-- ============================================================
-- Migration 0023: 逐次作答歷史 (attempts event log)
--
-- 在此之前只有聚合值:review_progress 累加 times_seen/times_correct,
-- exam_answers 以 (session_id, question_id) 為主鍵被後續作答覆寫,
-- 兩者都答不出「這題第幾次作答、花了多久」。
--
-- attempts 是 append-only 事件流,自此為作答的唯一真相;
-- review_progress 的聚合欄位降級為 derived cache(仍雙寫,因為它
-- 同時存 bookmark),exam_answers 仍是模擬考的當前作答狀態。
--
-- elapsed_ms:前端量測的「實際看著這題的毫秒數」,分頁隱藏期間
-- 不計(frontend/src/lib/questionTimer.ts),伺服器再夾到 [0, 30分鐘]。
-- ============================================================

CREATE TABLE attempts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_email  TEXT    NOT NULL REFERENCES users(email) ON DELETE CASCADE,
  question_id TEXT    NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  chosen      TEXT,                 -- 'A'..'E';NULL = 未作答(交卷時的空題)
  is_correct  INTEGER,              -- 0/1;NULL = 尚未判定(模擬考交卷前)
  source      TEXT    NOT NULL,     -- 'review' | 'exam' | 'drill' | 'anki'
  session_id  TEXT,                 -- exam_sessions.id;非 exam 來源為 NULL
  elapsed_ms  INTEGER,              -- 夾值後的單題耗時;NULL = 未回報
  created_at  INTEGER NOT NULL
);

-- 個人時間軸(學習曲線、配速摘要、heatmap 逐次計數)
CREATE INDEX idx_attempts_user_time ON attempts (user_email, created_at DESC);
-- 單題全體耗時分佈(中位數 / 百分位)
CREATE INDEX idx_attempts_question ON attempts (question_id, elapsed_ms);
-- 一場模擬考的逐題耗時(檢討頁 + 前後半段對比)
CREATE INDEX idx_attempts_session ON attempts (session_id, created_at);
```

**Step 2** — 套用並驗證:

```bash
pnpm db:migrate:local
wrangler d1 execute $(node scripts/lib/cfg.mjs project.d1_db) --local \
  --command "SELECT name FROM sqlite_master WHERE type='table' AND name='attempts'"
```

Expected:回一列 `attempts`。

**Step 3** — commit:

```bash
git add migrations/0023_attempts.sql
git commit -m "feat(attempts): append-only per-answer attempt log with timing"
```

---

## Task 1.2: 伺服器端 elapsed_ms 夾值 + 寫入 helper(TDD)

**Files:** Create: `worker/lib/attempts.ts` · Test: `worker/lib/attempts.test.ts`

**Step 1 — 失敗測試** `worker/lib/attempts.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { clampElapsedMs, MAX_ELAPSED_MS } from "./attempts.ts";

test("正常值原樣通過(取整)", () => {
  assert.equal(clampElapsedMs(74_321), 74_321);
  assert.equal(clampElapsedMs(74_321.9), 74_321);
});

test("未回報 / 非數字 → null", () => {
  for (const v of [
    undefined,
    null,
    Number.NaN,
    "74000",
    Number.POSITIVE_INFINITY,
  ])
    assert.equal(clampElapsedMs(v), null);
});

test("負數夾到 0,超大值夾到上限", () => {
  assert.equal(clampElapsedMs(-5), 0);
  assert.equal(clampElapsedMs(9_999_999_999), MAX_ELAPSED_MS);
});
```

**Step 2:** `pnpm test` → FAIL(找不到模組)。

**Step 3 — 實作** `worker/lib/attempts.ts`:

```ts
import type {
  D1Database,
  D1PreparedStatement,
} from "@cloudflare/workers-types";

/** 單題耗時上限 30 分鐘。前端已在 10 分鐘截斷(questionTimer),
 *  這層只防惡意 / 時鐘跳動的離譜值。 */
export const MAX_ELAPSED_MS = 30 * 60 * 1000;

export type AttemptSource = "review" | "exam" | "drill" | "anki";

/** 不信任 client:非有限數字一律 null,其餘夾進 [0, MAX_ELAPSED_MS]。 */
export function clampElapsedMs(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return Math.min(Math.max(Math.trunc(v), 0), MAX_ELAPSED_MS);
}

export function insertAttemptOp(args: {
  db: D1Database;
  email: string;
  questionId: string;
  chosen: string | null;
  isCorrect: 0 | 1 | null;
  source: AttemptSource;
  sessionId?: string | null;
  elapsedMs: number | null;
  now: number;
}): D1PreparedStatement {
  return args.db
    .prepare(
      `INSERT INTO attempts
       (user_email, question_id, chosen, is_correct, source, session_id, elapsed_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      args.email,
      args.questionId,
      args.chosen,
      args.isCorrect,
      args.source,
      args.sessionId ?? null,
      args.elapsedMs,
      args.now,
    );
}
```

**Step 4:** `pnpm test` → PASS。`pnpm exec tsc --noEmit` 過。

**Step 5:** commit `feat(attempts): elapsed_ms clamping + insert helper`。

---

## Task 1.3: `POST /api/review/answer` 接受 elapsed_ms 並雙寫

**Files:** Modify: `worker/routes/review.ts:136-174`(`/answer`)、`worker/routes/review.ts:431-556`(`/anki/review`)

**Step 1:** `/answer` 的 body 型別加 `elapsed_ms?: number`(與 `confidence?` 同樣 optional,舊 client 不送照常運作):

```ts
const body = await c.req.json<{
  question_id: string;
  chosen: string;
  confidence?: number;
  elapsed_ms?: number;
  source?: "review" | "drill";
}>();
```

**Step 2:** 算完 `isCorrect` 後,把既有的 `answerProgressOp(...)` 與新的 `insertAttemptOp(...)` 合併成一次 `c.env.DB.batch([...])`(現況是單獨 `.run()`,`worker/routes/review.ts:153-160`),讓聚合與事件同進同退:

```ts
const elapsedMs = clampElapsedMs(body.elapsed_ms);
await c.env.DB.batch([
  answerProgressOp({
    email,
    questionId: body.question_id,
    chosen: body.chosen,
    isCorrect,
    now,
    db: c.env.DB,
  }),
  insertAttemptOp({
    db: c.env.DB,
    email,
    questionId: body.question_id,
    chosen: body.chosen,
    isCorrect,
    source: body.source === "drill" ? "drill" : "review",
    sessionId: null,
    elapsedMs,
    now,
  }),
]);
```

`confidence_events` 的插入維持原樣(`worker/routes/review.ts:164-171`),不併入本 batch 也不移除。

**Step 3:** `/anki/review` 同樣加 `elapsed_ms?: number`,在既有 `ops` 陣列(`worker/routes/review.ts:473`)最後 push 一筆 `insertAttemptOp({ ..., source: "anki", chosen })`。**只在 `chosen` 有值時 push** —— 沒選項的純 rating 不是一次 MCQ 作答。

**Step 4 — 手動驗證:**

```bash
curl -s -X POST localhost:8787/api/review/answer -H 'X-Dev-Email: <admin>' \
  -H 'content-type: application/json' \
  -d '{"question_id":"114-001","chosen":"A","elapsed_ms":74000}'
wrangler d1 execute $(node scripts/lib/cfg.mjs project.d1_db) --local \
  --command "SELECT source, chosen, elapsed_ms FROM attempts ORDER BY id DESC LIMIT 3"
```

Expected:一列 `review | A | 74000`。再送一次不帶 `elapsed_ms` → `elapsed_ms` 為 NULL 且不報錯。

**Step 5:** commit `feat(review): accept per-question elapsed_ms, log attempts`。

---

## Task 1.4: exam answer 端點接受 elapsed_ms

**Files:** Modify: `worker/routes/exam.ts:215-242`(`/:sid/answer`)、`worker/routes/exam.ts:245-301`(`/:sid/finish`)

**Step 1:** `/:sid/answer` body 加 `elapsed_ms?: number`。既有的 `UPDATE exam_answers`(`worker/routes/exam.ts:232-239`)保留不動 —— 它仍是 resume 用的當前狀態。額外 append 一筆 attempt:

```ts
const elapsedMs = clampElapsedMs(body.elapsed_ms);
await c.env.DB.batch([
  ,
  /* 既有的 UPDATE exam_answers ... */ insertAttemptOp({
    db: c.env.DB,
    email,
    questionId: body.question_id,
    chosen: body.chosen,
    isCorrect: null, // 模擬考交卷前不揭曉,判定留給 finish
    source: "exam",
    sessionId: sid,
    elapsedMs,
    now: Date.now(),
  }),
]);
```

**注意:** 使用者改答案會產生多筆 attempt(這是刻意的 —— 改答案本身就是配速訊號)。配速報告以 `SUM(elapsed_ms)` 聚合同一 `(session_id, question_id)`,見 Task 3.1。

**Step 2:** `/:sid/finish` 在既有的 `UPDATE exam_answers ... is_correct`(`worker/routes/exam.ts:263-273`)之後,補一句把該場的 attempts 判定回填(讓 `attempts` 不留 NULL):

```sql
UPDATE attempts
SET is_correct = CASE
      WHEN chosen = (SELECT COALESCE(ea.correct_answer_at_finish, q.answer)
                     FROM exam_answers ea JOIN questions q ON q.id = ea.question_id
                     WHERE ea.session_id = attempts.session_id
                       AND ea.question_id = attempts.question_id)
      THEN 1 ELSE 0 END
WHERE session_id = ? AND is_correct IS NULL
```

用 `correct_answer_at_finish` 快照(而非 `questions.answer`),與 `worker/routes/exam.ts:266` 的既有設計一致 —— 日後 challenge 升級答案不會回頭改寫歷史。

**Step 3 — 驗證:** 本地開一場考、答 3 題、交卷,然後

```bash
wrangler d1 execute $(node scripts/lib/cfg.mjs project.d1_db) --local \
  --command "SELECT question_id, chosen, is_correct, elapsed_ms FROM attempts WHERE source='exam' ORDER BY id"
```

Expected:每題至少一列,交卷後 `is_correct` 皆非 NULL。

**Step 4:** commit `feat(exam): log per-question attempts with elapsed time`。

---

## Task 2.1: 前端單題計時純函式(TDD)

**Files:** Create: `frontend/src/lib/questionTimer.ts` · Test: `frontend/src/lib/questionTimer.test.ts`

計時的核心風險是**「離開分頁去查資料」汙染耗時**。設計:狀態機累加「可見且未暫停」的區間,`visibilitychange` → `hide()/show()`,單題硬上限 `MAX_QUESTION_MS = 10 分鐘`,超過即截斷並標 `outlier: true`(伺服器仍收,但配速統計會排除 outlier,見 Task 3.1)。純函式化:不註冊任何 listener、不讀 `Date.now()`,時間一律由呼叫端傳入。

**Step 1 — 失敗測試** `frontend/src/lib/questionTimer.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  startTimer,
  hide,
  show,
  pause,
  resume,
  read,
  MAX_QUESTION_MS,
} from "./questionTimer.ts";

test("連續可見的區間全部計入", () => {
  const t = startTimer(1_000);
  assert.deepEqual(read(t, 6_000), { elapsedMs: 5_000, outlier: false });
});

test("分頁隱藏期間不累加,回來後續計", () => {
  let t = startTimer(0);
  t = hide(t, 3_000); // 看了 3 秒
  t = show(t, 60_000); // 去查資料 57 秒 —— 不計
  assert.deepEqual(read(t, 62_000), { elapsedMs: 5_000, outlier: false });
});

test("隱藏中直接提交:讀數停在隱藏當下", () => {
  let t = startTimer(0);
  t = hide(t, 4_000);
  assert.deepEqual(read(t, 999_000), { elapsedMs: 4_000, outlier: false });
});

test("暫停中提交(模擬考按暫停)不繼續累加", () => {
  let t = pause(startTimer(0), 2_000);
  assert.equal(read(t, 500_000).elapsedMs, 2_000);
  t = resume(t, 500_000);
  assert.equal(read(t, 503_000).elapsedMs, 5_000);
});

test("超過單題上限 → 截斷並標 outlier", () => {
  assert.deepEqual(read(startTimer(0), MAX_QUESTION_MS + 60_000), {
    elapsedMs: MAX_QUESTION_MS,
    outlier: true,
  });
});

test("快速連答:換題重啟後歸零", () => {
  const a = startTimer(0);
  assert.equal(read(a, 800).elapsedMs, 800);
  assert.equal(read(startTimer(800), 1_100).elapsedMs, 300);
});

test("重複 hide / 重複 show 具冪等性(瀏覽器會重放事件)", () => {
  let t = hide(hide(startTimer(0), 1_000), 5_000); // 第二次 hide 不倒扣
  t = show(show(t, 9_000), 9_500); // 第二次 show 不重設起點
  assert.equal(read(t, 10_000).elapsedMs, 2_000);
});
```

**Step 2:** `cd frontend && node --test --experimental-strip-types src/lib/questionTimer.test.ts` → FAIL。

**Step 3 — 實作** `frontend/src/lib/questionTimer.ts`:狀態 `{ accumulatedMs: number; runningSince: number | null }`(與 worker 端 `elapsed_ms / running_since` 同構,好記)。

- `startTimer(now)` → `{ accumulatedMs: 0, runningSince: now }`
- `hide/pause(t, now)` → 已停止就原樣回傳(冪等);否則結算 `accumulatedMs += now - runningSince`,`runningSince = null`
- `show/resume(t, now)` → 已在跑就原樣回傳;否則 `runningSince = now`
- `read(t, now)` → `raw = accumulatedMs + (runningSince ? now - runningSince : 0)`;`{ elapsedMs: Math.min(raw, MAX_QUESTION_MS), outlier: raw > MAX_QUESTION_MS }`
- 全部回傳新物件(不可變),`hide`/`pause` 與 `show`/`resume` 可共用實作但保留兩組名稱以表達意圖。

**Step 4:** 測試 → PASS。

**Step 5:** commit `feat(timer): pure per-question timer with visibility pausing`。

---

## Task 2.2: 接上複習模式 QuestionCard

**Files:** Modify: `frontend/src/components/QuestionCard.tsx`(`submit()` 在 `:65-78`)

**Step 1:** 加一個 `useRef<TimerState>` + `useEffect`:題目 id 變更時 `startTimer(Date.now())` 重新計時;掛 `document.addEventListener('visibilitychange', ...)`,依 `document.hidden` 呼叫 `hide/show`,cleanup 時移除。

**Step 2:** `submit()` 內 `const { elapsedMs } = read(timer.current, Date.now())`,把 `elapsed_ms: elapsedMs` 併進既有的 POST body(該 body 現在是 `{ question_id, chosen, confidence }`,`frontend/src/components/QuestionCard.tsx:71`)。

**Step 3:** 揭曉後在既有的匿名統計列旁多顯示一行「你 74 秒 · 全體中位數 52 秒」(資料來自 Task 3.2 的擴充 `/:id/stats`;`stats` state 已存在於 `frontend/src/components/QuestionCard.tsx:55`,只需擴 type)。中位數為 `null`(樣本不足)時只顯示自己的秒數,不顯示比較。

**Step 4:** `cd frontend && pnpm typecheck`,`pnpm dev` 手動走:答一題 → DevTools Network 看 body 有 `elapsed_ms`;中途切到別的分頁 30 秒再回來作答 → 秒數不應包含那 30 秒。

**Step 5:** commit `feat(ui): time each review answer, show vs cohort median`。

---

## Task 2.3: 接上模擬考 Exam.tsx

**Files:** Modify: `frontend/src/routes/Exam.tsx`(`choose()` 在 `:307-318`,pause/resume 在 `:320-340`)

**Step 1:** `ExamInProgress` 內加 `const timer = useRef(startTimer(Date.now()))`,在 `activeIdx` 變更的 `useEffect` 裡重新 `startTimer`(換題即歸零)。

**Step 2:** `choose()` 的 debounce flush(`frontend/src/routes/Exam.tsx:312-317`)送出時附 `elapsed_ms: read(timer.current, Date.now()).elapsedMs`。

**Step 3:** 讓題級 timer 跟隨 session 的暫停狀態:`pause()` 成功後呼叫 `pause(timer.current, ...)`,`resume()` 後呼叫 `resume(...)`;同時掛 `visibilitychange` 如 Task 2.2。**注意**現有 `isPaused` 時 `choose()` 直接 return(`frontend/src/routes/Exam.tsx:308`),所以暫停中不會有作答寫入。

**Step 4:** `submit()`(`frontend/src/routes/Exam.tsx:342-368`)重送所有答案的迴圈**不要**再附 `elapsed_ms`(那是補寫,不是新的作答;避免灌入假的耗時)。

**Step 5:** 手動:開一場考,答 3 題後暫停 2 分鐘再繼續答第 4 題 → 第 4 題耗時不含暫停時間。

**Step 6:** commit `feat(exam): per-question timing synced with session pause`。

---

## Task 3.1: 配速統計純函式(TDD)

**Files:** Create: `worker/lib/pacing.ts` · Test: `worker/lib/pacing.test.ts`

**Step 1 — 失敗測試** `worker/lib/pacing.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { percentile, median, pacingSplit, MIN_COHORT } from "./pacing.ts";

test("中位數:奇數取中、偶數取平均、空陣列 null", () => {
  assert.equal(median([10, 20, 30]), 20);
  assert.equal(median([10, 20, 30, 40]), 25);
  assert.equal(median([]), null);
});

test("百分位使用線性插值,且不依賴輸入排序", () => {
  assert.equal(percentile([50, 10, 30, 20, 40], 0.5), 30);
  assert.equal(percentile([10, 20], 0.25), 12.5);
  assert.equal(percentile([10], 0.9), 10);
});

test("前後半段配速:偶數題平分,奇數題中間題歸前段", () => {
  const out = pacingSplit([10, 10, 30, 50]);
  assert.deepEqual(out, {
    firstHalfAvg: 10,
    secondHalfAvg: 40,
    deltaPct: 300,
    n: 4,
  });
});

test("樣本不足以分半 → null 摘要", () => {
  assert.equal(pacingSplit([]), null);
  assert.equal(pacingSplit([42]), null);
});

test("匿名門檻:少於 MIN_COHORT 人不回中位數", () => {
  assert.ok(MIN_COHORT >= 5);
});
```

**Step 2:** `pnpm test` → FAIL。

**Step 3 — 實作** `worker/lib/pacing.ts`:

- `percentile(xs, p)`:複製後排序、線性插值 `idx = (n-1)*p`;`n === 0` → `null`。
- `median(xs)` = `percentile(xs, 0.5)`。
- `pacingSplit(xs)`:`n < 2` → `null`;`mid = Math.ceil(n/2)`;回 `{ firstHalfAvg, secondHalfAvg, deltaPct, n }`,`deltaPct = Math.round((second/first - 1) * 100)`(`first === 0` → `deltaPct: null`)。**輸入必須是作答順序**,函式本身不排序。
- `export const MIN_COHORT = 5;` —— 全體中位數的最小作答人數。20 人的群體裡,5 人以下的「全體中位數」等同點名,故低於門檻一律回 `null`(與 `worker/routes/questions.ts:453-472` 既有的 `responders` 概念一致,但那支目前沒有門檻,本計畫只在**新增的耗時欄位**上套門檻,不改動既有 accuracy 的行為)。

**Step 4:** `pnpm test` → PASS。

**Step 5:** commit `feat(pacing): percentile/median/split helpers with cohort threshold`。

---

## Task 3.2: 單題耗時比較 — 擴充 `GET /api/questions/:id/stats`

**Files:** Modify: `worker/routes/questions.ts:453-472`

**Step 1:** 既有回傳 `{attempts, correct, responders, accuracy}` 全部保留(前端 `frontend/src/components/QuestionCard.tsx:49-54` 依賴),**只加欄位**:

```ts
const { results: times } = await c.env.DB.prepare(
  `SELECT user_email, MIN(elapsed_ms) AS ms
   FROM attempts
   WHERE question_id = ? AND elapsed_ms IS NOT NULL AND elapsed_ms > 0
   GROUP BY user_email`, // 每人取「最快一次」,避免重刷同一題灌樣本
)
  .bind(id)
  .all<{ user_email: string; ms: number }>();

const my = times.find((r) => r.user_email === c.var.email)?.ms ?? null;
const cohort = times.length >= MIN_COHORT ? times.map((r) => r.ms) : [];
```

回傳新增 `{ my_elapsed_ms: my, median_elapsed_ms: median(cohort), p90_elapsed_ms: percentile(cohort, 0.9), timed_responders: times.length }`。人數不足時中位數/p90 為 `null`(前端據此隱藏比較文案)。

**Step 2:** 排除 outlier:SQL 加 `AND elapsed_ms <= 600000`(10 分鐘,對齊前端 `MAX_QUESTION_MS`),避免「開著分頁去吃飯」拉高中位數。

**Step 3 — 驗證:**

```bash
curl -s localhost:8787/api/questions/114-001/stats -H 'X-Dev-Email: <admin>' | jq
```

Expected:舊欄位不變,新增四個欄位;單人資料下 `median_elapsed_ms` 為 `null` 而 `my_elapsed_ms` 有值。

**Step 4:** commit `feat(questions): expose per-question timing percentiles`。

---

## Task 3.3: 模擬考配速報告端點

**Files:** Modify: `worker/routes/exam.ts:304-330`(`GET /:sid`) · Create: `GET /api/exam/:sid/pacing`(同檔新增)

**Step 1:** `GET /:sid` 的 answers 查詢(`worker/routes/exam.ts:316-327`)左接 attempts 聚合,加一欄 `elapsed_ms`:

```sql
LEFT JOIN (
  SELECT question_id, SUM(elapsed_ms) AS elapsed_ms
  FROM attempts WHERE session_id = ? AND elapsed_ms IS NOT NULL
  GROUP BY question_id
) t ON t.question_id = ea.question_id
```

`SUM` 而非 `MAX`:同題改答案會有多筆 attempt,總和才是這題真正花掉的時間。舊 session 無 attempts → `NULL`,前端顯示「—」。

**Step 2:** 新增 `GET /:sid/pacing`(先做 owner 檢查,同 `worker/routes/exam.ts:313-314` 的 `user_email !== email → 403`):

```sql
SELECT question_id, SUM(elapsed_ms) AS ms
FROM attempts WHERE session_id = ? AND elapsed_ms IS NOT NULL
GROUP BY question_id
ORDER BY MIN(created_at)     -- 作答順序,不是題號順序
```

把 `ms` 陣列丟進 `pacingSplit()`,回:

```jsonc
{
  "n": 100,
  "first_half_avg_ms": 41000,
  "second_half_avg_ms": 78000,
  "delta_pct": 90,
  "median_ms": 52000,
  "slowest": [{ "question_id": "114-073", "number": 73, "ms": 210000 }], // top 5
}
```

`slowest` 需 join `questions.number` 供顯示。無資料 → `{ n: 0, ... null }`(前端顯示空狀態,不報錯)。

**Step 3 — 驗證:**

```bash
curl -s localhost:8787/api/exam/<sid>/pacing -H 'X-Dev-Email: <admin>' | jq
```

**Step 4:** commit `feat(exam): session pacing report endpoint`。

---

## Task 3.4: 檢討頁 UI — 每題耗時欄 + 配速摘要

**Files:** Modify: `frontend/src/routes/ExamResult.tsx`

**Step 1:** `Result['answers']` 型別(`frontend/src/routes/ExamResult.tsx:15-22`)加 `elapsed_ms: number | null`;在每題那行的 meta 區(`:120-130`,現有「✗ 你選 A · 正解 B」)後面接 `· 用時 1:14`,`null` 時顯示 `· 用時 —`。格式化沿用該檔既有的 `mins/secs` 風格,mm:ss。

**Step 2:** 分數 banner(`:58-72`)下方加一張配速卡:呼叫 `/api/exam/:sid/pacing`,顯示

> 前半段平均 41 秒 · 後半段平均 78 秒 · **後段慢了 90%**

`delta_pct > 25` 時把數字上 `text-rose-700 dark:text-rose-400`(該檔 `:65` 已有此配色慣例),`< -25` 用 emerald,其餘用 ink。下方一行「最慢五題」小連結,連到 `/q/<id>`(沿用 `:101` 的連結樣式)。`n === 0` 時整張卡改成一行灰字「本場沒有逐題計時資料(舊場次)」。

**Step 3:** 不引入任何圖表函式庫 —— 純文字 + 既有 Tailwind class,維持 scholarly 語氣、無漸層無陰影堆疊。

**Step 4:** `cd frontend && pnpm typecheck && pnpm build`;本地跑完一場考確認耗時欄與配速卡都出得來。

**Step 5:** commit `feat(ui): per-question時間 column + pacing summary on exam result`。

---

## Task 4.1: heatmap 改吃 attempts(順手修正低估)

**Files:** Modify: `worker/routes/review.ts:307-336`

**Step 1:** 現行 heatmap 的第一個 UNION 分支用 `review_progress.last_seen_at`(`worker/routes/review.ts:316-317`)—— 一天答 10 題只算 1 次,因為那是聚合列。改成 `SELECT created_at AS ts FROM attempts WHERE user_email = ? AND created_at >= ?`。

**Step 2:** 同時移除 `exam_answers` 分支(`worker/routes/review.ts:322-324`)—— exam 作答現在也進 `attempts`,留著會**重複計數**。`fsrs_review_logs` 分支保留(那是排程複習,與 MCQ 作答不同事件),但若 `attempts` 已含 `source='anki'` 且該次有 `chosen`,兩者會重疊;**採取的取捨**:保留 fsrs 分支,因為純 rating(無 chosen)不會進 attempts,移除會漏記。此重疊在註解裡寫明。

**Step 3:** **相容性警告**(必須寫進 commit message):`attempts` 從 0023 才開始寫,舊資料不會回填,所以 heatmap 的歷史格子會變空。若使用者在意,改為「`created_at >= <0023 套用時間>` 用 attempts,更早用 review_progress」的 UNION —— 先問使用者要哪種,預設採簡單版(直接切換)。

**Step 4 — 驗證:** 一天內答 3 題,heatmap 該日應為 3 而非 1。

**Step 5:** commit `fix(heatmap): count每次作答 from attempts instead of aggregates`。

---

## Task 4.2: 個人學習曲線(`GET /api/review/pacing`)

**Files:** Modify: `worker/routes/review.ts`(新增端點)

**Step 1:** `GET /api/review/pacing?days=90`,按 UTC+8 日期分桶(沿用 `worker/routes/review.ts:326` 的 `strftime(... , '+8 hours')` 寫法):

```sql
SELECT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch', '+8 hours') AS d,
       COUNT(*) AS n,
       SUM(CASE WHEN is_correct = 1 THEN 1 ELSE 0 END) AS correct,
       AVG(CASE WHEN elapsed_ms BETWEEN 1 AND 600000 THEN elapsed_ms END) AS avg_ms
FROM attempts
WHERE user_email = ? AND created_at >= ?
GROUP BY d ORDER BY d
```

**Step 2:** 回傳陣列;`avg_ms` 可為 `null`(該日全無計時)。這支是「回溯學習曲線」的資料基礎 —— **本計畫不做對應的前端圖表**(非目標),只確保資料拿得到。

**Step 3:** commit `feat(review): daily pacing/accuracy series from attempts`。

---

## Task 4.3: 對帳查詢 + 文件

**Files:** Modify `CLAUDE.md`(「Key Design Decisions」新增一小節)

**Step 1:** 在 CLAUDE.md 加約 8 行:`attempts` 是作答唯一真相、`review_progress` 是 derived cache(仍雙寫,因為它同時存 bookmark)、新功能一律讀 `attempts`。

**Step 2:** 附上對帳查詢(日後懷疑漂移時用):

```sql
SELECT rp.user_email, rp.question_id, rp.times_seen, COUNT(a.id) AS attempts_n
FROM review_progress rp
LEFT JOIN attempts a ON a.user_email = rp.user_email AND a.question_id = rp.question_id
WHERE rp.last_seen_at > <0023 套用時間>   -- 更早的資料必然不等(未回填)
GROUP BY rp.user_email, rp.question_id
HAVING rp.times_seen <> attempts_n LIMIT 20;
```

**Step 3:** commit `docs: attempts as source of truth, review_progress as derived`。

---

## 驗收清單

- [ ] `pnpm test` 全綠(新增 `worker/lib/attempts.test.ts`、`worker/lib/pacing.test.ts`)
- [ ] `cd frontend && node --test --experimental-strip-types src/lib/questionTimer.test.ts` 全綠
- [ ] `pnpm exec tsc --noEmit`(worker)+ `cd frontend && pnpm build` 皆過
- [ ] `wrangler d1 execute <db> --local --command "PRAGMA table_info(attempts)"` 有 8 欄 + 3 個 index
- [ ] 複習模式答一題 → `attempts` 多一列且 `elapsed_ms` 合理;切分頁 30 秒不計入
- [ ] 不帶 `elapsed_ms` 的請求(模擬舊 client)照常 200,`elapsed_ms` 為 NULL
- [ ] `elapsed_ms: -1` → 存 0;`elapsed_ms: 1e12` → 存 1800000;`elapsed_ms: "abc"` → 存 NULL
- [ ] 模擬考交卷後 `attempts.is_correct` 無 NULL,檢討頁每題有耗時欄
- [ ] `/api/exam/:sid/pacing` 回前後半段;沒有計時資料的舊 session 回 `n: 0` 不 500
- [ ] `/api/questions/:id/stats` 在 timed_responders < 5 時 `median_elapsed_ms` 為 `null`
- [ ] 換人 session 存取 `/pacing` 回 403(owner check)

---

## 風險與回滾

**資料遷移風險 —— 不回填。** `attempts` 是新的事件流,歷史上根本沒有逐次紀錄可以還原(`review_progress` 只有聚合、`exam_answers` 已被覆寫)。任何「回填」都只能造假(例如把 `times_seen=5` 展開成 5 筆假時間戳),那會汙染唯一真相並讓中位數失真。**明確決定:不回填**,舊資料的配速欄一律顯示「—」。代價是 Task 4.1 的 heatmap 歷史格會變空,已在該 task Step 3 標為需先問使用者。

**雙寫回滾。** `review_progress` 的寫入路徑完全沒改(`answerProgressOp` 原封不動,只是從 `.run()` 移進 `batch()`),所以回滾 = revert Task 1.3/1.4 兩個 commit 即可,`attempts` 表留著不影響任何舊功能(沒有任何既有查詢會讀它)。migration 不需回滾;若真要,`DROP TABLE attempts` 是安全的 —— 沒有其他表外鍵指向它。

**批次原子性。** `D1.batch()` 是單一交易,聚合與事件同進同退,不會出現「times_seen 加了但 attempts 沒寫」。

**Task 4.1 是唯一有破壞性的一步**(改變 heatmap 語意 + 移除 exam_answers 分支)。它獨立成 commit,revert 即完全復原。

**時鐘不可信。** `elapsed_ms` 由 client 量測,使用者可以偽造。這是內部 20 人讀書會、不是排行榜競賽,接受此風險;伺服器夾值(`clampElapsedMs`)只防離譜值造成統計爆掉。

**隱私。** 全體中位數在 `timed_responders < MIN_COHORT(5)` 時回 `null`。20 人的群體裡這道門檻是必要的 —— 3 個人的「中位數」等於點名。個人耗時只回自己的(`c.var.email` 過濾)。

---

## 成本

**D1 寫入。** 每次作答新增 1 列 `attempts`。上限估算:20 人 × 1000 題 × 平均 3 次作答 ≈ **60,000 列**;模擬考改答案會多一些,抓 2 倍上限 ≈ 120,000 列(這是**整個題庫做完 3 遍的總量**,不是每日量)。

- 每列約 90 bytes(email ~25B + question_id 7B + 6 個小欄位 + index overhead),120,000 列 ≈ **11 MB**,含三個 index 抓 3 倍 ≈ **33 MB**。D1 免費儲存上限 5 GB → 用掉 0.7%。
- 寫入行數:D1 免費方案每日 100,000 rows written。單人一天做 100 題 = 100 列 attempts(+ 100 列 review_progress upsert + 100 列 confidence_events),20 人全力衝刺一天約 6,000 列 —— **遠低於上限**。真正接近上限的情境是重跑匯入腳本,與本功能無關。
- 讀取:配速端點都走 index(`idx_attempts_session` / `idx_attempts_question`),單場 100 題的聚合是幾百列的掃描,無壓力。

**其他:** 不新增 Workers AI 呼叫、不新增 Vectorize / R2 / DO 用量、不引入前端圖表函式庫。全案維持 free tier。

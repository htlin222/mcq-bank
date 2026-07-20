# 自訂測驗產生器 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 做一個對標 UWorld / AMBOSS「create test」的自訂測驗產生器:使用者用「題目狀態(未做過 / 做錯過 / 已收藏 / 曾答對)× 範圍(年份 / group / tag)× 題數 × 計時與否 × tutor|exam mode」組出一份卷,產生的 session **完全沿用現有 exam session 機制**(`/state`、`/answer`、`/pause`、`/resume`、`/finish` 一行都不重寫)。

**Architecture:** 一個純函式 `worker/lib/testBuilder.ts` 把篩選條件編譯成 SQL 片段(WHERE + JOIN + 參數陣列),兩個端點共用它:`POST /api/exam/custom/preview`(只回 count,給 UI 即時顯示「符合 137 題」)與 `POST /api/exam/custom`(選題 + 建 session,回傳體與 `POST /start` 同形)。`exam_sessions` 加四個欄位標記「這是自訂測驗」與其模式,`exam_answers` 加 `seq` 解決跨年份題號排序問題。前端新頁 `/exam/new`,tutor mode 直接重用 `Question.tsx` 既有的 `AnnotatableContent` 詳解元件。

**Tech Stack:** Cloudflare Workers (Hono) + D1 (SQLite),前端 React 18 + Vite + TailwindCSS。測試 `node --test`(`node:test` + `node:assert/strict`),`pnpm test` 已設定為 `node --test 'worker/**/*.test.ts'`(`package.json:25`)。**不新增任何 Cloudflare 服務**。

---

## 現況(實作前已核對)

**Exam session 流程**(`worker/routes/exam.ts`):
- `POST /start`(`:37`)— body `{ year, mode?, groups? }`;`groups` 從 `env.GROUPS` 驗證(`:29-33`),`SELECT ... WHERE year = ? AND "group" IN (...) ORDER BY number ASC`(`:54-62`),`cap_ms = questions.length * 60_000`(`:10`、`:69`),然後一個 `DB.batch` 寫 session + 每題一列空 `exam_answers`(`:72-89`)。
- `GET /:sid/state`(`:108`)— 擁有者檢查 + `ORDER BY q.number ASC`(`:121-130`),回 `live elapsed`(`:132-134`)。
- `POST /:sid/pause`(`:153`)/ `resume`(`:183`,超過 `cap_ms` 回 409 `:201`)/ `answer`(`:215`,只 UPDATE `exam_answers`)/ `finish`(`:245`,`correct_answer_at_finish` 快照 + `Math.min(liveElapsed, cap_ms)` `:287`)。
- `GET /:sid`(`:304`,結果頁,同樣 `ORDER BY q.number ASC` `:324`)、`DELETE /:sid`(`:334`)、`GET /`(歷史,`:351`)。
- **關鍵限制:** 兩處排序都靠 `q.number`,自訂測驗跨年份時 `number` 會重複 → 必須加排序欄位。

**Schema:**
- `exam_sessions`(`migrations/0001_initial_schema.sql:104-113`)— `year INTEGER NOT NULL`(`:107`)、`mode TEXT DEFAULT 'full'`(`:112`);後續加 `elapsed_ms` / `running_since`(`migrations/0007_exam_pause.sql:17-18`)、`cap_ms INTEGER NOT NULL DEFAULT 6000000`(`migrations/0010_exam_cap_ms.sql:13`)。
- `exam_answers`(`0001:118-126`)— PK `(session_id, question_id)`,無排序欄位。
- `review_progress`(`0001:128-138`)— `times_seen` / `times_correct`(`:131-132`)、`last_correct`(`:135`);`bookmarked` 欄位已於 `migrations/0006_bookmark_folders.sql:41` 移除。
- `bookmark_items`(`0006:22-29`)— PK `(user_email, question_id)`,`folder_id` 可為 NULL。
- `question_tags`(`migrations/0003_year_and_groups.sql:26`)、`questions."group"`(`0003:15`,CHECK 內科/共同)。
- **現存最後一支 migration 是 `0022_highlights.sql`。** 本計畫指定用 **0023**;實作前務必先 `ls migrations/` 重新確認最後一號,若已有 0023 就往後順延並同步改本文件的檔名。

**篩選既有寫法(可抄的樣板):**
- `GET /api/questions`(`worker/routes/questions.ts:17`)— year / group / q / tags,tag 走 `HAVING COUNT(DISTINCT tag) = ?` 的 **AND** 語意(`:46-64`)。
- `GET /api/review/wrong`(`worker/routes/review.ts:594`)— 錯題判準 `rp.times_seen > 0 AND (rp.times_correct * 100 / rp.times_seen) < 100`(`:600-604`)。
- Meta 端點:`/_meta/years`(`questions.ts:479`)、`/_meta/groups`(`:487`)、`/_meta/tags`(`:499`)。

**前端:**
- `frontend/src/routes/Exam.tsx` — `Exam()` 依 `:sid` 分派 `ExamStart` / `ExamInProgress`(`:28-32`);`ExamStart` 抓 `/_meta/years` + group toggle(`:37-166`);`ExamInProgress` 的 tick(`:255-259`)、cap 自動交卷(`:275-279`)、`choose()` debounce 400ms POST answer(`:307-318`)。
- `frontend/src/routes/ReviewIndex.tsx:86-104` — 「隨機抽一題」按鈕與「信心校準 / 弱點地圖」區塊,是加入口的自然位置。
- `frontend/src/routes/Lists.tsx:20` — `WrongQuestions`,year/group/tag 三段式篩選 UI(`:33-53` 的 query 組法可直接抄成表單)。
- 路由表 `frontend/src/App.tsx:168-204`(`/exam` `:176`、`/exam/:sid` `:177`、`/exam/:sid/result` `:178`);導覽 `App.tsx:130`(桌機)與 `:214`(手機底部)。
- tutor mode 要重用的詳解渲染:`frontend/src/routes/Question.tsx:932-936` 的 `<AnnotatableContent content={explanationJson} …>`;逐題作答的既有樣板見 `frontend/src/routes/Drill.tsx:1-80`(`useQuestion` + `QuestionCard`)。

---

## 關鍵決策

**D1: 新增欄位,不開新表。** 自訂測驗的資料形狀跟現有 session 完全一樣(一份 session + N 列答案),另開 `custom_sessions` 表會讓 `/state`、`/answer`、`/finish`、`/:sid`、歷史列表全部要分岔判斷,是純粹的重複。故在 `exam_sessions` 加 4 個有 DEFAULT 的欄位(舊列自動落在「年度考」語意),另在 `exam_answers` 加 `seq`。

**`year NOT NULL` 怎麼辦:** SQLite 的 `ALTER TABLE` 不能放寬 NOT NULL,重建表會動到已套用的 schema。自訂測驗一律寫 `year = 0` 當哨兵值,並以 `kind = 'custom'` 為唯一判準(**禁止用 `year === 0` 判斷 kind**,顯示層才把 0 翻成「自訂」)。

**端點:新開 `POST /api/exam/custom`,不擴充 `/start`。** `/start` 的契約是「year 必填 + groups 從 `env.GROUPS` 驗證 + 依 number 排序」,把可選狀態/多年份/亂數選題塞進去會讓兩種語意在同一個 handler 裡互相污染,且舊前端仍在打 `/start`。新端點在建立 session 之後產出的資料列與 `/start` 完全同構,下游端點零改動(除了排序)。

**Tag 用 OR 語意**(與 `/api/questions` 的 AND 不同):組卷時「AML 或 MDS 都算」才是使用者要的;AND 在多選 tag 時幾乎必然回 0 題。這個差異要寫在 `testBuilder.ts` 的註解裡。

---

## 非目標

- 不寫新的作答引擎、不新增計時模型(沿用 `elapsed_ms` / `running_since` / `cap_ms`)。
- 不做「儲存我的測驗模板」、不做排程/每日自動出題。
- 不讓自訂測驗回寫 `review_progress`(現有 exam 流程本來就不寫,只有 `POST /api/review/answer` 寫);維持一致。
- 不碰 FSRS / Anki 佇列、不碰 Vectorize 語意選題(未來要做再說)。
- 不做題目「已讀但未作答」這種第五種狀態。

## 跨切面約定

- Auth 一律 `c.var.email`(Cloudflare Access 已驗過 JWT),**不得自建 auth**;每個端點都要做擁有者檢查,樣板見 `exam.ts:228-230`。
- migration 只新增、不改已套用檔案。
- 資源名走 `config.toml`,程式碼裡不得 hard-code slug / host / db 名。group 標籤從 `env.GROUPS`(worker)與 `frontend/src/lib/groups.ts` 的 `GROUPS`(前端)取,不寫死「內科/共同」。
- UI:scholarly/editorial,ink/cream + 單一 accent `#a8442a`;Tailwind 只有 `accent` / `accent-dark` / `accent-light`,**不存在 `accent-50` / `accent-800`**;無漸層、無玻璃擬態。
- 測試檔與原始碼同目錄 `*.test.ts`;純邏輯先抽函式、先寫失敗測試。
- 每個 Task 結束就 commit,且能獨立 commit。

---

### Task 1.1: migration 0023 — session 種類欄位 + 答案排序欄位

**Files:**
- Create: `migrations/0023_custom_test_sessions.sql`
- Modify: `worker/types.ts`(`ExamSession` 型別,現況 `:125-134`)
- Test: 無(純 schema,由 Task 1.2 之後的端點測試覆蓋)

**Step 1 — 先確認編號:** `ls migrations/ | tail -3`,確認最後一支是 `0022_highlights.sql`;若已有更高號,把本檔改成「最後號 +1」。

**Step 2 — 寫 migration:**
```sql
-- ============================================================
-- Migration 0023: Custom test builder sessions
--
-- 自訂測驗沿用 exam_sessions/exam_answers,不另開表。舊列的 DEFAULT
-- 就是原本的「年度全真考」語意,無需 backfill。
--
--   kind        'year'(依年份出卷,即 POST /start)| 'custom'
--   tutor       1 = 每題作答後立即揭曉答案與詳解
--   timed       0 = 不計時(cap_ms 仍存在,但設得極大且前端改為計時往上跑)
--   filter_json 產生這份卷的篩選條件快照(可重跑 / 除錯用)
--
-- year 是 NOT NULL 且 SQLite 不能放寬,custom 一律寫 0 當哨兵;
-- 判斷種類請一律看 kind,不要看 year。
-- ============================================================

ALTER TABLE exam_sessions ADD COLUMN kind TEXT NOT NULL DEFAULT 'year';
ALTER TABLE exam_sessions ADD COLUMN tutor INTEGER NOT NULL DEFAULT 0;
ALTER TABLE exam_sessions ADD COLUMN timed INTEGER NOT NULL DEFAULT 1;
ALTER TABLE exam_sessions ADD COLUMN filter_json TEXT;

-- 自訂測驗跨年份,q.number 會重複,必須有明確順序。
-- 舊列為 NULL,查詢一律 COALESCE(ea.seq, q.number)。
ALTER TABLE exam_answers ADD COLUMN seq INTEGER;
```

**Step 3 — 套用:** `pnpm db:migrate:local`。

**Step 4 — 型別:** `worker/types.ts` 的 `ExamSession` 補上
```ts
  kind: 'year' | 'custom';
  tutor: 0 | 1;
  timed: 0 | 1;
  filter_json: string | null;
```

**Step 5 — 驗證:**
```bash
wrangler d1 execute $(node scripts/lib/cfg.mjs project.d1_db) --local \
  --command "PRAGMA table_info(exam_sessions)"
pnpm exec tsc --noEmit
```
Expected: 看到 `kind/tutor/timed/filter_json`,tsc 無錯。

**Commit:** `git commit -m "feat(exam): schema for custom test sessions (kind/tutor/timed/seq)"`

---

### Task 1.2: `testBuilder.ts` — 篩選條件 → SQL(TDD)

**Files:**
- Create: `worker/lib/testBuilder.ts`
- Test: `worker/lib/testBuilder.test.ts`

純函式,不碰 D1。輸入篩選條件 + user email,輸出 `{ joinSql, whereSql, params }`,由 preview 與 build 兩個端點共用。

**Step 1 — 失敗測試** `worker/lib/testBuilder.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTestFilter, normalizeFilters } from "./testBuilder.ts";

test("無任何條件 = 全題庫,只有 user email 一個參數", () => {
  const f = buildTestFilter(normalizeFilters({}), "a@b.c");
  assert.equal(f.whereSql, "");
  assert.deepEqual(f.params, ["a@b.c", "a@b.c"]); // rp join + bi join
});

test("狀態複選是 OR 語意,包在同一組括號裡", () => {
  const f = buildTestFilter(normalizeFilters({ status: ["unseen", "bookmarked"] }), "a@b.c");
  assert.match(f.whereSql, /^WHERE \(.*OR.*\)$/s);
  assert.match(f.whereSql, /rp\.question_id IS NULL/);
  assert.match(f.whereSql, /bi\.question_id IS NOT NULL/);
});

test("範圍條件之間是 AND,狀態組與範圍組也是 AND", () => {
  const f = buildTestFilter(
    normalizeFilters({ status: ["wrong"], years: [114, 113], groups: ["內科"] }),
    "a@b.c",
  );
  assert.equal(f.whereSql.split(" AND ").length, 3); // status組 / year組 / group組
  assert.deepEqual(f.params.slice(2), [114, 113, "內科"]);
});

test("tag 多選是 OR(與 /api/questions 的 AND 刻意不同)", () => {
  const f = buildTestFilter(normalizeFilters({ tags: ["AML", "MDS"] }), "a@b.c");
  assert.match(f.whereSql, /EXISTS \(SELECT 1 FROM question_tags/);
  assert.deepEqual(f.params.slice(2), ["AML", "MDS"]);
});

test("normalizeFilters:題數夾在 1..100、未知狀態剔除、空陣列視為不限", () => {
  assert.equal(normalizeFilters({ count: 999 }).count, 100);
  assert.equal(normalizeFilters({ count: 0 }).count, 1);
  assert.equal(normalizeFilters({}).count, 20); // 預設 20 題
  assert.deepEqual(normalizeFilters({ status: ["unseen", "bogus"] as any }).status, ["unseen"]);
  assert.deepEqual(normalizeFilters({ years: [] }).years, []);
});
```

**Step 2:** `pnpm test` → FAIL(模組不存在)。

**Step 3 — 實作** `worker/lib/testBuilder.ts`:
```ts
// 自訂測驗的篩選編譯器。純函式:輸入條件 → SQL 片段 + 參數,
// preview(算 COUNT)與 build(選題建 session)共用同一份,避免兩邊漂移。
//
// 語意:
//   status 之間 OR(「未做過 或 做錯過」= 兩者聯集)
//   scope(year / group / tag)之間 AND,同一維度內部 OR
//   tag 用 OR — 與 GET /api/questions 的 AND(questions.ts:46-64)刻意不同:
//   組卷時多選 tag 若取交集幾乎必然 0 題。

export type TestStatus = "unseen" | "wrong" | "correct" | "bookmarked";
export const ALL_STATUS: TestStatus[] = ["unseen", "wrong", "correct", "bookmarked"];

export type TestFilters = {
  status: TestStatus[];   // 空 = 不限
  years: number[];        // 空 = 不限
  groups: string[];       // 空 = 不限
  tags: string[];         // 空 = 不限
  count: number;          // 1..100
};

export function normalizeFilters(raw: Partial<TestFilters> | undefined): TestFilters { /* … */ }

// 兩個 LEFT JOIN 固定存在(狀態判斷需要),所以 params 前兩個永遠是 email。
export const TEST_JOIN_SQL = `
  LEFT JOIN review_progress rp ON rp.question_id = q.id AND rp.user_email = ?
  LEFT JOIN bookmark_items  bi ON bi.question_id = q.id AND bi.user_email = ?`;

export function buildTestFilter(
  f: TestFilters,
  email: string,
): { joinSql: string; whereSql: string; params: unknown[] } { /* … */ }
```
狀態片段(照抄,語意對齊 `review.ts:600-604`):
```ts
const STATUS_SQL: Record<TestStatus, string> = {
  unseen:     "(rp.question_id IS NULL OR rp.times_seen = 0)",
  wrong:      "(rp.times_seen > 0 AND rp.times_correct < rp.times_seen)",
  correct:    "(rp.times_correct > 0)",
  bookmarked: "(bi.question_id IS NOT NULL)",
};
```

**Step 4:** `pnpm test` → PASS。

**Step 5:** `pnpm exec tsc --noEmit`。

**Commit:** `git commit -m "feat(exam): pure filter compiler for custom test builder"`

---

### Task 2.1: `POST /api/exam/custom/preview` — 即時符合題數

**Files:**
- Modify: `worker/routes/exam.ts`(接在 `/start` handler 之後,`:104` 後方)
- Test: 手動 `curl`(SQL 組法已由 1.2 的單元測試覆蓋)

**Step 1:** 新增 handler:
```ts
// 預覽符合題數 — UI 每次改條件就打一次,只做一個 COUNT(*),不建 session。
examRoutes.post('/custom/preview', async (c) => {
  const email = c.var.email;
  const f = normalizeFilters(await c.req.json().catch(() => ({})));
  const { joinSql, whereSql, params } = buildTestFilter(f, email);
  const row = await c.env.DB
    .prepare(`SELECT COUNT(*) AS n FROM questions q ${joinSql} ${whereSql}`)
    .bind(...params)
    .first<{ n: number }>();
  const available = row?.n ?? 0;
  return c.json({ available, requested: f.count, will_use: Math.min(available, f.count) });
});
```

**Step 2:** 路由順序注意 — `/custom/preview` 必須註冊在 `examRoutes.get('/:sid', …)`(`:304`)之前才不會被吃掉;因為是 `POST` 且 `:sid` 是 `GET`,實際上不衝突,但仍統一放在 `/start` 後面保持可讀性。

**Step 3 — 驗證:**
```bash
curl -s -X POST localhost:8787/api/exam/custom/preview \
  -H 'X-Dev-Email: <admin_email from config.toml>' -H 'content-type: application/json' \
  -d '{"status":["unseen"],"years":[114],"count":20}' | jq
```
Expected: `{"available":N,"requested":20,"will_use":…}`;把 `status` 換成 `["wrong"]`、`years` 加一年,數字要跟著變。

**Commit:** `git commit -m "feat(exam): custom test preview count endpoint"`

---

### Task 2.2: `POST /api/exam/custom` — 建立自訂 session

**Files:**
- Modify: `worker/routes/exam.ts`

**Step 1:** handler 主體(選題 → 建 session,回傳體與 `/start`(`:91-103`)同形,前端可共用型別):
```ts
const UNTIMED_CAP_MS = 24 * 60 * 60 * 1000; // 不計時:cap 大到不會觸發自動交卷

examRoutes.post('/custom', async (c) => {
  const email = c.var.email;
  const body = await c.req.json<Partial<TestFilters> & { tutor?: boolean; timed?: boolean }>();
  const f = normalizeFilters(body);
  const { joinSql, whereSql, params } = buildTestFilter(f, email);

  // 隨機抽題:D1 的 RANDOM() 對 1000 列題庫成本可忽略。
  const { results: questions } = await c.env.DB
    .prepare(
      `SELECT q.id, q.year, q.number, q.stem, q.options_json
       FROM questions q ${joinSql} ${whereSql}
       ORDER BY RANDOM() LIMIT ?`
    )
    .bind(...params, f.count)
    .all<Pick<Question, 'id' | 'year' | 'number' | 'stem' | 'options_json'>>();

  if (questions.length === 0) {
    return c.json({ error: 'no questions match', available: 0 }, 404);
  }
  // 不足時不報錯 — 直接用實際可用題數出卷,回傳體帶 requested/actual 讓 UI 講清楚。
  …
});
```

**Step 2:** 寫入(對照 `/start` 的 batch `:72-89`):
- `kind='custom'`、`year=0`、`mode='partial'`、`tutor = body.tutor ? 1 : 0`、`timed = body.timed === false ? 0 : 1`、`filter_json = JSON.stringify(f)`。
- `cap_ms = timed ? questions.length * MS_PER_QUESTION : UNTIMED_CAP_MS`(`MS_PER_QUESTION` 見 `:10`)。
- `exam_answers` 插入時帶 `seq`:`INSERT INTO exam_answers (session_id, question_id, seq) VALUES (?, ?, ?)`,`seq` 用迴圈 index(自訂測驗的題序即抽出來的順序)。

**Step 3:** 回傳
```ts
return c.json({
  session_id: sessionId, started_at: now, elapsed_ms: 0, running_since: now,
  cap_ms: capMs, kind: 'custom', tutor: …, timed: …,
  requested: f.count, actual: questions.length,
  questions: questions.map((q) => ({ id: q.id, year: q.year, number: q.number,
    stem: q.stem, options: optionsToRecord(q.options_json) })),
});
```

**Step 4 — 驗證:**
```bash
SID=$(curl -s -X POST localhost:8787/api/exam/custom -H 'X-Dev-Email: <admin>' \
  -H 'content-type: application/json' \
  -d '{"status":["unseen","wrong"],"years":[114,113],"count":5,"tutor":true,"timed":false}' \
  | jq -r .session_id)
curl -s localhost:8787/api/exam/$SID/state -H 'X-Dev-Email: <admin>' | jq '.questions | length'
curl -s -X POST localhost:8787/api/exam/$SID/finish -H 'X-Dev-Email: <admin>' | jq
```
Expected: 5 題;`/finish` 回 `{score, duration_sec}`(證明下游端點零改動就能用)。

**Commit:** `git commit -m "feat(exam): POST /api/exam/custom builds a session from filters"`

---

### Task 2.3: 讓 `/state` 與 `/:sid` 用 `seq` 排序

**Files:**
- Modify: `worker/routes/exam.ts:121-130`(state 查詢)、`:316-327`(結果查詢)

**Step 1:** 兩處的 `ORDER BY q.number ASC` 改成:
```sql
ORDER BY COALESCE(ea.seq, q.number) ASC, q.year ASC, q.number ASC
```
`COALESCE` 保住舊 session(`seq` 為 NULL)的既有行為,`q.year` 是跨年份時的次序保險。

**Step 2:** `/state` 與 `/:sid` 的 SELECT 各補 `q.year`,回傳體多一個 `year` 欄位(前端自訂測驗要顯示「114-007」而不是只有題號)。年度考的前端忽略這欄即可,向後相容。

**Step 3:** `/state` 回傳體補 `kind` / `tutor` / `timed`(前端要靠這三個決定 UI),從 `session` 物件直接帶出。

**Step 4 — 驗證:** 用 Task 2.2 的 `$SID` 重新 `GET /state`,確認題序穩定且與建立時一致;再開一場舊式 `/start` 的年度考,確認題號仍 1→100 遞增。

**Commit:** `git commit -m "fix(exam): order answers by seq so cross-year sessions keep their order"`

---

### Task 3.1: 前端 `/exam/new` — 表單 + 即時題數

**Files:**
- Create: `frontend/src/routes/CustomTest.tsx`
- Modify: `frontend/src/App.tsx`(路由,插在 `:176` 的 `/exam` 之前)
- Modify: `frontend/src/routes/Exam.tsx`(`ExamStart` 頂部加入口連結)

決定:**新開獨立頁面 `/exam/new`**,不塞進 ReviewIndex。理由:表單有 5 組控制項,塞進複習首頁會壓過該頁「選年度」的主要動線;而且產生的是 exam session,歸在 `/exam` 命名空間語意才對。

**Step 1:** 頁面骨架 — 四個區塊,視覺沿用 `Lists.tsx:56-` 的 chip/toggle 樣式與 `Exam.tsx:168-193` 的 `GroupToggle`:
1. **題目狀態**(4 顆可複選 chip:未做過 / 做錯過 / 已收藏 / 曾答對)
2. **範圍** — 年份多選(`/api/questions/_meta/years`)、group 多選(`frontend/src/lib/groups.ts` 的 `GROUPS`,不寫死標籤)、tag 多選(`/api/questions/_meta/tags`,預設只顯示前 30 個 + 「更多」)
3. **題數** — `<input type="range" min=1 max=100>` + 數字顯示
4. **模式** — 計時 / 不計時二選一;tutor mode / exam mode 二選一,各附一行說明(tutor:「每題作答後立刻看答案與詳解」)

**Step 2 — 即時題數:** 條件變動時 debounce 300ms 打 `POST /api/exam/custom/preview`,顯示
「符合 **137** 題 · 本次出 20 題」;`available < requested` 時改顯示
「只找到 **8** 題符合,將出 8 題」(明確告知,不靜默截斷);`available === 0` 時 disable 開始鈕並提示放寬條件。用 `AbortController` 取消過期請求。

**Step 3 — 開始:** `POST /api/exam/custom` → `sessionStorage.setItem('exam-'+id, …)`(對齊 `Exam.tsx:81`)→ `navigate('/exam/'+id)`。

**Step 4:** `App.tsx` 加 `<Route path="/exam/new" element={<CustomTest />} />`,**必須放在 `/exam/:sid` 之前**,否則 `new` 會被當成 sid。

**Step 5 — 驗證:** `pnpm dev` + `cd frontend && pnpm dev`,開 `/exam/new`,勾「做錯過」+ 114 年,題數拉到 10,確認題數即時更新、按開始能進 `/exam/:sid` 且題目正確。

**Commit:** `git commit -m "feat(ui): custom test builder page at /exam/new"`

---

### Task 3.2: tutor mode — 作答後立即揭曉

**Files:**
- Modify: `frontend/src/routes/Exam.tsx`(`ExamInProgress`)
- Create: `frontend/src/components/TutorReveal.tsx`

**Step 1:** `ExamState` 型別加 `kind?: 'year' | 'custom'`、`tutor?: 0 | 1`、`timed?: 0 | 1`、題目加 `year?: number`(Task 2.3 已回傳)。

**Step 2:** `TutorReveal.tsx` — props `{ questionId: string; chosen: string }`。內部用既有 `useQuestion(questionId)` hook 取完整題目(含 `answer` 與 `explanation`),渲染:
- 一行「你選 X · 正解 Y」(對/錯用既有的 emerald / rose 色階,見 `ReviewIndex.tsx:148-152`)
- 詳解用 `<AnnotatableContent content={explanationJson} storeKey={'anno:exp:'+questionId} />`,與 `Question.tsx:932-936` 同一份元件與 storeKey 慣例 → 畫記自動跨頁共用
- 底部一個 `→ 看完整討論` 連到 `/q/:id`(新分頁)

**Step 3 — 觸發時機:** `tutor === 1` 時,`choose()`(`Exam.tsx:307-318`)成功後把該題標記為 revealed 並鎖住選項(不可改答);`tutor === 0` 完全維持現行行為。**只有在 chosen 送出後才 mount `TutorReveal`** — 否則 `/api/questions/:id` 會提前把答案送到瀏覽器。

**Step 4 — 驗證:** 用 tutor + 不計時建一場 5 題測驗,逐題作答:每題按下選項後立刻出現正解 + 詳解,且不能改答;交卷後結果頁分數正確。再建一場 exam mode,確認全程看不到答案。

**Commit:** `git commit -m "feat(ui): tutor mode reveals answer + explanation per question"`

---

### Task 3.3: 不計時計時器 + 自訂測驗的標題與歷史顯示

**Files:**
- Modify: `frontend/src/routes/Exam.tsx`(計時器區塊、`:285-303` 的 `live`/`remaining`/`fmt`)
- Modify: `frontend/src/routes/ExamResult.tsx`(`:36-40` 的標題區)
- Modify: `frontend/src/routes/ExamHistory.tsx`(列表列)

**Step 1:** `timed === 0` 時,把倒數改成正數計時(顯示 `fmt(live)` 並標「不計時」),且不顯示紅色告警;`Exam.tsx:275-279` 的 cap 自動交卷邏輯保持原樣(24 小時 cap 事實上不會觸發)。

**Step 2:** 標題:`kind === 'custom'` 顯示「自訂測驗」而非年度;結果頁與歷史列表同理 — **判斷一律用 `kind`,不要用 `year === 0`**。歷史列表的自訂測驗可額外顯示 `filter_json` 摘要(如「未做過 · 114,113 · 20 題」),沒有就只顯示「自訂」。

**Step 3 — 驗證:** 建 timed / untimed 各一場,確認計時方向正確;`/exam-history` 兩種 session 都顯示得體。

**Commit:** `git commit -m "feat(ui): untimed stopwatch + custom-session labels in exam views"`

---

### Task 3.4: 入口

**Files:**
- Modify: `frontend/src/routes/Exam.tsx`(`ExamStart`)
- Modify: `frontend/src/routes/ReviewIndex.tsx`
- Modify: `frontend/src/routes/Lists.tsx`(`WrongQuestions`)

**Step 1:** `ExamStart`(`Exam.tsx:90-165`)在年度卡片上方加一張同樣視覺語言的「自訂測驗」卡:標題 + 一行說明「挑狀態、範圍與題數,自己出一份卷」→ `/exam/new`。

**Step 2:** `ReviewIndex.tsx:86-91` 的「隨機抽一題」旁加次要連結「或 自訂一份測驗 →」。

**Step 3:** `WrongQuestions`(`Lists.tsx:20`)頁首加「把這些出成一份測驗 →」,帶著當前的 year/group/tag 以 query string 進 `/exam/new`(頁面初始化時讀 `useSearchParams` 預填,status 預設勾「做錯過」)。

**Step 4:** **不新增底部導覽項**(`App.tsx:210-218` 已有 5 項,再加會擠);桌機導覽(`:130`)也維持不動。

**Step 5 — 驗證:** 三個入口都能到 `/exam/new`,錯題頁帶入的條件正確預填。

**Commit:** `git commit -m "feat(ui): entry points to the custom test builder"`

---

## 驗收清單

- [ ] `pnpm test` 全綠(含新的 `testBuilder.test.ts`)
- [ ] `pnpm exec tsc --noEmit` 無錯;`cd frontend && pnpm build` 成功
- [ ] `POST /custom/preview` 的 `available` 與同條件下 `POST /custom` 實際出題數一致(不足時 `actual = available`)
- [ ] 狀態複選是聯集:單選「未做過」+ 單選「做錯過」的 available 相加 ≥ 兩者複選的 available(有重疊時 >)
- [ ] 自訂 session 走完整流程:`/state` → `/answer` → `/pause` → `/resume` → `/finish` → 結果頁,全部不需改 handler(除 Task 2.3 的排序)
- [ ] 跨年份自訂測驗的題序在 refresh 後不變(`seq` 生效)
- [ ] 舊式年度考(`POST /start`)行為零變化:題序 1→100、倒數計時、結果頁正常
- [ ] tutor mode 在送出答案「之前」不會發出 `/api/questions/:id` 請求(DevTools Network 確認)
- [ ] 不計時 session 不會被自動交卷;計時 session 到 cap 仍自動交卷
- [ ] 條件過嚴(0 題)時開始鈕 disabled 並有明確提示
- [ ] 沒有任何 hard-code 的 slug / host / group 標籤;UI 只用 `accent` / `accent-dark` / `accent-light`

## 風險與回滾

| 風險 | 對策 |
|---|---|
| `ORDER BY` 改動影響既有年度考 | `COALESCE(ea.seq, q.number)` 對 `seq IS NULL` 的舊列等價於原查詢;驗收清單有專項回歸 |
| `year = 0` 哨兵被誤當真年份 | 判斷一律用 `kind`;`_meta/years` 來自 `questions` 表不受影響;顯示層集中在 Task 3.3 |
| `ORDER BY RANDOM()` 效能 | 題庫 1000 列,全表掃描 <1ms;若未來題庫暴增再改成「抽 id 後隨機取樣」 |
| tutor mode 提前洩答案 | `TutorReveal` 只在 chosen 送出後 mount;驗收有 Network 檢查項 |
| 前端路由 `/exam/new` 被 `/exam/:sid` 吃掉 | Route 順序:`new` 在 `:sid` 之前;驗收時直接開 `/exam/new` 確認 |
| 需要回滾 | 全部改動是「新增欄位 + 新增端點 + 新增頁面」:`git revert` 相關 commit 即可;殘留的 5 個欄位有 DEFAULT,不影響舊程式碼(migration 不需回滾) |

## 成本(Cloudflare free tier)

- **新增服務:零。** 只用既有 D1 綁定,不碰 Workers AI / Vectorize / R2 / DO。
- **D1 讀取:** preview 每次一個 `COUNT(*)`(全表掃描 1000 列 + 兩個 index-backed LEFT JOIN);前端 debounce 300ms,20 人使用量遠低於免費額度(每日 500 萬 rows read)。
- **D1 寫入:** 每份自訂測驗 1 + N 列(N ≤ 100),與現有年度考同量級。
- **儲存:** 5 個欄位 × 既有列,增量以 KB 計。
- 結論:**不會推離 free tier。**

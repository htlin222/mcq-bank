# 跨年份統一到期佇列 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 讓「今天該複習什麼」變成單一入口。新增跨全部年份、按 `due_at` 排序的 FSRS 佇列(`/api/review/due` + `/due` 頁),並在首頁與 `/review` 放上「今天 N 張到期」badge。使用者不再需要自己記得哪一年有卡到期。

**Architecture:** 純查詢層 + 導覽層。排程演算法(`worker/lib/fsrs.ts`)與寫入路徑(`POST /anki/review`)一行都不動 —— 新佇列只是換一種方式挑「下一張」,挑完仍呼叫同一支 grade API。日界判定與新舊卡混合抽成 `worker/lib/` 兩支純函式,先寫失敗測試。

**Tech Stack:** Cloudflare Workers (Hono) + D1,前端 React 18 + Vite + Tailwind。測試 `pnpm test`(= `node --test 'worker/**/*.test.ts'`,`package.json:26`)。無新增 Cloudflare 資源。

---

## 現況(file:line 佐證)

- **FSRS 封裝**:`worker/lib/fsrs.ts:32-39` 建 scheduler(`request_retention 0.9`、`learning_steps ["1m","10m"]`);`nextFsrsCard()` `:100`、`previewFsrs()` `:108`、`retrievability()` `:118`。
- **Schema**:`migrations/0012_fsrs_anki.sql:9-25` 的 `fsrs_cards`,PK `(user_email, question_id)`。**`due_at` 是 `INTEGER NOT NULL`,存 epoch milliseconds(UTC)** —— 由 `card.due.getTime()` 產生(`worker/lib/fsrs.ts:87`),以 `new Date(row.due_at)` 讀回(`:74`)。**沒有時區語意,是絕對時間點。**
- **既有 index**:`idx_fsrs_cards_due(user_email, due_at)`(`migrations/0012_fsrs_anki.sql:27`)、`idx_fsrs_logs_user_reviewed(user_email, reviewed_at DESC)`(`:50`)。
- **佇列現況以年份為單位**:
  - `GET /anki/decks` `worker/routes/review.ts:339-342` → `getDeckStats()`(`:67-99`)的 per-year 陣列。
  - `GET /anki/decks/:year/next` `:346-427`。關鍵是 `WHERE q.year = ?`(`:371`)與 `fc.due_at <= ?`(`:372`),排序 learning(state 1,3) → 已排程 → 新卡(`:373-380`)。**新卡無每日上限**。
  - `POST /anki/review` `:431` upsert `fsrs_cards` + append `fsrs_review_logs`,可選 `chosen` 寫 `review_progress`(`:536`)。
- **「今天」既有慣例是 UTC+8**:`strftime(..., '+8 hours')`(`worker/routes/review.ts:326`)。
- **前端入口只有一個**:`/anki/:year` 路由 `frontend/src/App.tsx:171`;唯一連結來自 `frontend/src/routes/YearList.tsx:152`。`AnkiDeck.tsx` 共 441 行,`useParams<{year}>` `:83`、抓卡 `:97`、評分 `:132`、空佇列畫面 `:196-205`、卡片本體 `:206` 起。
- **首頁 / 複習頁沒有任何到期提示**:`Home.tsx:49-55`、`ReviewIndex.tsx:35-37` 只抓 `_meta/years` 與 `/api/review/stats`。

## 非目標

- **不改 FSRS 排程演算法** —— `worker/lib/fsrs.ts` 完全不動。
- **不改既有逐年入口** —— `/anki/decks`、`/anki/decks/:year/next`、`POST /anki/review`、`/anki/:year` 頁面行為維持原狀。考前衝刺單一年份仍有價值,兩者**並存**。
- 不做設定持久化(新卡上限、日界時數走預設 + query param,不加 `users` 欄位)。
- 不碰 `review_progress` 語意、不做離線預抓。

| 端點 | 職責 |
| --- | --- |
| `GET /anki/decks/:year/next` | 「我要刷 113 年」:限定年份、無新卡上限、附 deck 統計 |
| `GET /api/review/due/next` | 「今天該做什麼」:跨全年份、按 due 排序、套每日新卡上限與交錯 |

## 跨切面約定

- Auth 一律 `c.var.email`(Cloudflare Access 已驗過),handler 內不自行解析 JWT。
- **預期不需要 migration**:跨年份 due 查詢正好命中既有 `idx_fsrs_cards_due`。若 Task 4.1 的 `EXPLAIN QUERY PLAN` 顯示 full scan 才補;現況最後一支是 `migrations/0022_highlights.sql`,故新檔應為 **`0023_*`**(任務描述提到的 0029 與現況不符 —— 實作前務必 `ls migrations/ | sort | tail -1` 重新確認)。
- 測試檔與原始碼同目錄 `*.test.ts`,`node:test` + `node:assert/strict`。
- UI 沿用 scholarly/editorial:ink/cream + accent `#a8442a`。Tailwind `accent` 只有 `DEFAULT`/`dark`/`light`,別寫 `accent-600`。
- 每個 Task 獨立 commit。

---

### Task 1.1: 日界判定純函式(TDD)

**Files:** Create `worker/lib/due-window.ts` / Test `worker/lib/due-window.test.ts`

**決策:支援「一天的開始時間」,預設凌晨 4 點。** 使用者是台灣醫師(UTC+8),熬夜讀到凌晨兩點是常態;日界設在午夜的話,凌晨 1 點打開會看到「今天 0 張」然後突然跳出一整批,體感是被打斷。Anki 預設 `rollover = 4am` 正為此。成本只是一個常數,不支援反而之後要回頭改資料語意。時區硬編 UTC+8(全員同時區,且與 `review.ts:326` 一致),`dayStartHour` 可由 query param 覆寫但不持久化。

規則分兩層:**review 卡** `due_at <= dayEnd`(日級精度,今天稍晚到期今天就能做,同 Anki);**learning/relearning 卡** `due_at <= now`(分鐘級,不能提前)。

**Step 1 — 失敗測試** `worker/lib/due-window.test.ts`(一律用含 offset 的 ISO,避免宿主時區汙染):

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { dayWindow, isDueToday, DEFAULT_DAY_START_HOUR } from "./due-window.ts";
const T = (iso: string) => Date.parse(iso);

test("預設日界是台北凌晨 4 點", () => {
  assert.equal(DEFAULT_DAY_START_HOUR, 4);
  const w = dayWindow(T("2026-07-20T10:00:00+08:00"));
  assert.equal(w.dayStart, T("2026-07-20T04:00:00+08:00"));
  assert.equal(w.dayEnd, T("2026-07-21T04:00:00+08:00"));
  assert.equal(w.dayKey, "2026-07-20");
});
test("凌晨 2 點仍屬前一天(熬夜不跳號)", () => {
  assert.equal(dayWindow(T("2026-07-21T02:30:00+08:00")).dayKey, "2026-07-20");
});
test("剛好落在邊界 04:00:00.000 算新的一天", () => {
  assert.equal(dayWindow(T("2026-07-21T04:00:00+08:00")).dayKey, "2026-07-21");
});
test("dayStartHour 可覆寫為 0", () => {
  assert.equal(dayWindow(T("2026-07-21T02:30:00+08:00"), { dayStartHour: 0 }).dayKey, "2026-07-21");
});
test("review 卡:今天稍晚到期算今天,未來卡不算", () => {
  const now = T("2026-07-20T10:00:00+08:00"), w = dayWindow(now);
  assert.equal(isDueToday({ due_at: T("2026-07-20T23:00:00+08:00"), state: 2 }, now, w), true);
  assert.equal(isDueToday({ due_at: T("2026-07-22T09:00:00+08:00"), state: 2 }, now, w), false);
});
test("learning 卡必須 due <= now", () => {
  const now = T("2026-07-20T10:00:00+08:00"), w = dayWindow(now);
  assert.equal(isDueToday({ due_at: now + 300_000, state: 1 }, now, w), false);
  assert.equal(isDueToday({ due_at: now - 300_000, state: 3 }, now, w), true);
});
test("從未複習過的新卡(無 row)永遠可做", () => {
  const now = T("2026-07-20T10:00:00+08:00");
  assert.equal(isDueToday(null, now, dayWindow(now)), true);
});
```

**Step 2:** `pnpm test` → FAIL(找不到模組)。

**Step 3 — 實作** `worker/lib/due-window.ts`:

```ts
export const TZ_OFFSET_MS = 8 * 60 * 60 * 1000; // 全員在台灣,不做 per-user 時區
export const DEFAULT_DAY_START_HOUR = 4;
const DAY_MS = 86_400_000;

export type DayWindow = { dayStart: number; dayEnd: number; dayKey: string };
export type DueLike = { due_at: number; state: number } | null;

export function clampHour(h: number): number {
  return Number.isFinite(h) && h >= 0 && h <= 23 ? Math.floor(h) : DEFAULT_DAY_START_HOUR;
}

export function dayWindow(now: number, opts: { dayStartHour?: number } = {}): DayWindow {
  const shift = TZ_OFFSET_MS - clampHour(opts.dayStartHour ?? DEFAULT_DAY_START_HOUR) * 3_600_000;
  const dayIndex = Math.floor((now + shift) / DAY_MS);
  return {
    dayStart: dayIndex * DAY_MS - shift,
    dayEnd: (dayIndex + 1) * DAY_MS - shift,
    dayKey: new Date(dayIndex * DAY_MS).toISOString().slice(0, 10),
  };
}

// state: 0=New 1=Learning 2=Review 3=Relearning(ts-fsrs State enum)
export function isDueToday(card: DueLike, now: number, w: DayWindow): boolean {
  if (!card || card.state === 0) return true;          // 未建卡 / 新卡
  if (card.state === 1 || card.state === 3) return card.due_at <= now; // 分鐘級
  return card.due_at <= w.dayEnd;                       // Review:日級
}
```

**Step 4:** `pnpm test` → PASS;`pnpm exec tsc --noEmit` 乾淨。

**Step 5:** `git add worker/lib/due-window.*` → `git commit -m "feat(due): pure day-boundary helpers with 4am rollover (UTC+8)"`

### Task 1.2: 新卡 / 到期卡混合策略純函式(TDD)

**Files:** Create `worker/lib/queue-mix.ts` / Test `worker/lib/queue-mix.test.ts`

**決策:** `DEFAULT_NEW_PER_DAY = 20` —— 1000 題、20 張/天約 50 天讀完全庫,對照考期節奏合理,也是 Anki 預設;`?new_limit=` 可覆寫(0 = 今天只清舊帳)。**順序 learning → due → new,以 `NEW_EVERY = 4` 交錯**(每 3 張到期卡插 1 張新卡)。理由:「先清完到期再上新卡」會讓到期量大的日子永遠碰不到新卡(引入速度歸零);「新卡優先」則會在中途放棄時把到期卡堆到明天。learning 永遠插隊 —— 那是幾分鐘後就該再見的短期步驟,延後等於作廢。

**Step 1 — 失敗測試** `worker/lib/queue-mix.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { pickNextKind, remainingNewToday, DEFAULT_NEW_PER_DAY, NEW_EVERY } from "./queue-mix.ts";
const S = (o: Partial<Parameters<typeof pickNextKind>[0]>) =>
  ({ served: 0, learning: 0, dueReview: 0, newAvailable: 0, newRemaining: 0, ...o });

test("預設 20 張/天、每 4 格給新卡一格", () => {
  assert.equal(DEFAULT_NEW_PER_DAY, 20);
  assert.equal(NEW_EVERY, 4);
});
test("learning 永遠插隊", () => {
  assert.equal(pickNextKind(S({ served: 3, learning: 1, dueReview: 9, newAvailable: 9, newRemaining: 9 })), "learning");
});
test("第 4 個位置(served=3)輪到新卡,其餘給到期卡", () => {
  assert.equal(pickNextKind(S({ served: 0, dueReview: 5, newAvailable: 5, newRemaining: 5 })), "due");
  assert.equal(pickNextKind(S({ served: 3, dueReview: 5, newAvailable: 5, newRemaining: 5 })), "new");
});
test("新卡額度用完就全給到期卡", () => {
  assert.equal(pickNextKind(S({ served: 3, dueReview: 5, newAvailable: 5, newRemaining: 0 })), "due");
});
test("沒有到期卡時新卡連發,額度歸零則 null", () => {
  assert.equal(pickNextKind(S({ newAvailable: 5, newRemaining: 2 })), "new");
  assert.equal(pickNextKind(S({ newAvailable: 5, newRemaining: 0 })), null);
});
test("全空回 null(佇列清空)", () => {
  assert.equal(pickNextKind(S({ served: 7, newRemaining: 20 })), null);
});
test("remainingNewToday 不為負", () => {
  assert.equal(remainingNewToday(5, 20), 15);
  assert.equal(remainingNewToday(25, 20), 0);
  assert.equal(remainingNewToday(0, 0), 0);
});
```

**Step 2:** `pnpm test` → FAIL。

**Step 3 — 實作** `worker/lib/queue-mix.ts`:

```ts
export const DEFAULT_NEW_PER_DAY = 20;
export const NEW_EVERY = 4;

export type QueueState = {
  served: number;       // 本 session 已送出張數
  learning: number;     // 現在可做的 learning/relearning
  dueReview: number;    // 今天到期的 review 卡
  newAvailable: number; // 題庫中尚未建卡的題數
  newRemaining: number; // 今日新卡剩餘額度
};
export type NextKind = "learning" | "due" | "new" | null;

export function pickNextKind(s: QueueState): NextKind {
  if (s.learning > 0) return "learning";
  const canNew = s.newAvailable > 0 && s.newRemaining > 0;
  if (s.dueReview <= 0) return canNew ? "new" : null;
  if (canNew && (s.served + 1) % NEW_EVERY === 0) return "new";
  return "due";
}

export function remainingNewToday(introducedToday: number, limit: number): number {
  const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 0;
  return Math.max(0, cap - introducedToday);
}

export function parseNewLimit(raw: string | undefined): number {
  if (!raw) return raw === "0" ? 0 : DEFAULT_NEW_PER_DAY;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.min(200, Math.floor(n)) : DEFAULT_NEW_PER_DAY;
}
```

**Step 4:** `pnpm test` → PASS。

**Step 5:** `git commit -m "feat(due): pure new/review interleave policy (20/day, 1-in-4)"`

### Task 2.1: `GET /api/review/due` —— 跨年份到期摘要

**Files:** Modify `worker/routes/review.ts`(插在 `/anki/decks`(`:339`)之後,不動既有 handler)

**Step 1:** 在既有 import 區(`:8-18`)加 `dayWindow, clampHour, DEFAULT_DAY_START_HOUR`(`../lib/due-window`)與 `parseNewLimit, remainingNewToday, pickNextKind`(`../lib/queue-mix`)。

**Step 2:** 新增 summary helper + handler(重點:review 卡用 `dayEnd`,learning 卡用 `now`):

```ts
async function getDueSummary(
  db: D1Database, email: string, now: number,
  opts: { dayStartHour: number; newLimit: number },
) {
  const w = dayWindow(now, { dayStartHour: opts.dayStartHour });
  const agg = await db.prepare(
    `WITH mine AS (SELECT * FROM fsrs_cards WHERE user_email = ?)
     SELECT
       SUM(CASE WHEN mine.state IN (1,3) AND mine.due_at <= ? THEN 1 ELSE 0 END) AS learning,
       SUM(CASE WHEN mine.state = 2 AND mine.due_at <= ? THEN 1 ELSE 0 END) AS due_review,
       SUM(CASE WHEN mine.question_id IS NULL OR mine.state = 0 THEN 1 ELSE 0 END) AS new_available,
       MIN(CASE WHEN mine.question_id IS NOT NULL AND mine.due_at > ? THEN mine.due_at END) AS next_due_at
     FROM questions q LEFT JOIN mine ON mine.question_id = q.id`,
  ).bind(email, now, w.dayEnd, w.dayEnd).first<Record<string, number | null>>();

  // log.state 是「複習前」狀態;=0 代表該卡首次亮相 = 今日引入的新卡
  const intro = await db.prepare(
    `SELECT COUNT(*) AS n FROM fsrs_review_logs
     WHERE user_email = ? AND reviewed_at >= ? AND reviewed_at < ? AND state = 0`,
  ).bind(email, w.dayStart, w.dayEnd).first<{ n: number }>();

  const { results: by_year } = await db.prepare(
    `WITH mine AS (SELECT * FROM fsrs_cards WHERE user_email = ?)
     SELECT q.year AS year, COUNT(*) AS due FROM questions q JOIN mine ON mine.question_id = q.id
     WHERE (mine.state IN (1,3) AND mine.due_at <= ?) OR (mine.state = 2 AND mine.due_at <= ?)
     GROUP BY q.year ORDER BY q.year DESC`,
  ).bind(email, now, w.dayEnd).all<{ year: number; due: number }>();

  const learning = agg?.learning ?? 0, due_review = agg?.due_review ?? 0;
  const new_available = agg?.new_available ?? 0;
  const new_remaining = Math.min(new_available, remainingNewToday(intro?.n ?? 0, opts.newLimit));
  return {
    learning, due_review, new_available, new_remaining,
    new_introduced_today: intro?.n ?? 0,
    due_total: learning + due_review + new_remaining,
    next_due_at: agg?.next_due_at ?? null, by_year,
    day_start_hour: opts.dayStartHour, day_start: w.dayStart, day_end: w.dayEnd,
  };
}

// 跨年份「今天該複習」摘要。逐年統計仍走 GET /anki/decks。
reviewRoutes.get("/due", async (c) => {
  const dayStartHour = clampHour(Number(c.req.query("day_start") ?? DEFAULT_DAY_START_HOUR));
  const newLimit = parseNewLimit(c.req.query("new_limit"));
  return c.json(await getDueSummary(c.env.DB, c.var.email, Date.now(), { dayStartHour, newLimit }));
});
```

**Step 3 — 驗證假設**(`fsrs_review_logs.state` 是複習前狀態):
```bash
pnpm exec tsc --noEmit
DB=$(node scripts/lib/cfg.mjs project.d1_db)
wrangler d1 execute "$DB" --local --command "SELECT state, COUNT(*) FROM fsrs_review_logs GROUP BY state"
wrangler d1 execute "$DB" --local --command "SELECT COUNT(*) FROM fsrs_cards"
```
`state=0` 的 log 筆數應等於已建卡數。若不成立,改以 `SELECT COUNT(*) FROM fsrs_cards WHERE created_at >= ? AND created_at < ?` 計今日引入(語意等價:建卡即引入)。再開 `pnpm dev` 打 `/api/review/due`,確認 `due_total = learning + due_review + new_remaining`。

**Step 4:** `git commit -m "feat(due): cross-year due summary endpoint"`

### Task 2.2: `GET /api/review/due/next` —— 取下一張

**Files:** Modify `worker/routes/review.ts`

**Step 1 — 純重構:** 把 year handler 內嵌的 question payload 組裝(`worker/routes/review.ts:406-426` 的 `question: {...}`)抽成 `function ankiQuestionPayload(row: AnkiQuestionRow, tagRows: {tag:string}[], now: number)`,兩支 handler 共用。year handler 回傳結構**一字不改**。

**Step 2 — 新 handler:** 先算 summary → `pickNextKind` 決定 kind → 依 kind 換 `WHERE`/`ORDER BY`。`served` 由前端帶。

```ts
// 跨年份到期佇列的下一張。與 /anki/decks/:year/next 並存:
// 那支是「我要刷某一年」,這支是「今天該做什麼」。評分仍走 POST /anki/review。
reviewRoutes.get("/due/next", async (c) => {
  const email = c.var.email, now = Date.now();
  const dayStartHour = clampHour(Number(c.req.query("day_start") ?? DEFAULT_DAY_START_HOUR));
  const newLimit = parseNewLimit(c.req.query("new_limit"));
  const served = Math.max(0, Number(c.req.query("served") ?? 0) || 0);

  const queue = await getDueSummary(c.env.DB, email, now, { dayStartHour, newLimit });
  const kind = pickNextKind({
    served, learning: queue.learning, dueReview: queue.due_review,
    newAvailable: queue.new_available, newRemaining: queue.new_remaining,
  });
  if (!kind) return c.json({ queue, kind: null, question: null });

  const filter = kind === "learning" ? "fc.state IN (1,3) AND fc.due_at <= ?"
    : kind === "due" ? "fc.state = 2 AND fc.due_at <= ?"
    : "(fc.question_id IS NULL OR fc.state = 0)";
  const order = kind === "new"
    ? "q.year DESC, q.number ASC"
    : "fc.due_at ASC, q.year DESC, q.number ASC";
  const bind = kind === "new" ? [email] : [email, kind === "learning" ? now : queue.day_end];

  // SELECT 欄位清單與 :353-367 相同(q.* + explanation_* + fsrs_*),只換 WHERE / ORDER BY
  const row = await c.env.DB.prepare(
    `SELECT q.*, e.content_json AS explanation_content_json, e.version AS explanation_version,
            e.updated_by AS explanation_updated_by, e.updated_at AS explanation_updated_at,
            fc.due_at AS fsrs_due_at, fc.stability AS fsrs_stability, fc.difficulty AS fsrs_difficulty,
            fc.elapsed_days AS fsrs_elapsed_days, fc.scheduled_days AS fsrs_scheduled_days,
            fc.learning_steps AS fsrs_learning_steps, fc.reps AS fsrs_reps, fc.lapses AS fsrs_lapses,
            fc.state AS fsrs_state, fc.last_review_at AS fsrs_last_review_at
     FROM questions q
     LEFT JOIN explanations e ON e.question_id = q.id
     LEFT JOIN fsrs_cards fc ON fc.question_id = q.id AND fc.user_email = ?
     WHERE ${filter} ORDER BY ${order} LIMIT 1`,
  ).bind(...bind).first<AnkiQuestionRow>();
  if (!row) return c.json({ queue, kind: null, question: null });

  const { results: tagRows } = await c.env.DB.prepare(
    "SELECT tag FROM question_tags WHERE question_id = ? ORDER BY created_at ASC",
  ).bind(row.id).all<{ tag: string }>();
  return c.json({ queue, kind, question: ankiQuestionPayload(row, tagRows, now) });
});
```

**Step 3 — 驗證:**
```bash
pnpm test && pnpm exec tsc --noEmit
# 手測 served=0..3,第 4 次(served=3)應回 kind="new"
# 回歸:/api/review/anki/decks/113/next 的 JSON 結構與改動前一致
```

**Step 4:** `git commit -m "feat(due): cross-year next-card endpoint with new/review interleave"`

### Task 3.1: 抽出可重用卡片元件(無行為變更)

**Files:** Create `frontend/src/components/AnkiCardView.tsx` / Modify `frontend/src/routes/AnkiDeck.tsx`

**Step 1:** 把 `AnkiDeck.tsx:17-76` 的型別(`RatingKey`/`FsrsCard`/`FsrsPreview`/`AnkiQuestion`)搬到 `AnkiCardView.tsx` 並 export,`AnkiDeck.tsx` 改為 re-import。

**Step 2:** 把 `<article data-testid="anki-card">`(`:206` 起)整段 —— 選項、揭曉、四顆評分鈕 —— 搬進 `AnkiCardView`,props:
```ts
type Props = {
  question: AnkiQuestion;
  chosen: string | null; onChoose: (l: string) => void;
  revealed: boolean; onReveal: () => void;
  grading: RatingKey | null; onGrade: (r: RatingKey) => void;
};
```

**Step 3:** `AnkiDeck.tsx` 改用 `<AnkiCardView … />`;header / deck 統計 / notice / error 留在原處。**本步不得改變任何視覺輸出。**

**Step 4:** `pnpm exec tsc --noEmit` 且 `cd frontend && pnpm build`;人工比對 `/anki/113` 與改動前一致。

**Step 5:** `git commit -m "refactor(anki): extract AnkiCardView presentational component"`

### Task 3.2: 新頁 `/due`

**Files:** Create `frontend/src/routes/DueQueue.tsx` / Modify `frontend/src/App.tsx`

**決策:新開 `/due`,不改造 `AnkiDeck`。** `AnkiDeck` 441 行且與 `useParams<{year}>` / deck 統計深度耦合(`:83`、`:97`、`:163-180`),撐成雙模式會讓每個分支都要判斷 year 是否存在。Task 3.1 已抽走真正重複的部分(卡片渲染),剩下的差異(標題、統計列、完成文案、`served` 計數)本來就該不同。

**Step 1 — 狀態機**(與 `AnkiDeck` 同型,差在 URL 與 `served`):
```tsx
const [served, setServed] = useState(0);
const loadNext = useCallback(async () => {
  const next = await api.get<DuePayload>(`/api/review/due/next?served=${served}`);
  setPayload(next); setChosen(null); setRevealed(false);
}, [served]);
// grade() 打 POST /api/review/anki/review(同 AnkiDeck.tsx:132),成功後 setServed((n) => n + 1)
```

**Step 2 — header:** `今天 {queue.due_total} 張 · 到期 {queue.due_review} · 學習中 {queue.learning} · 新卡 {queue.new_remaining}`,並依 `kind` 標一枚 chip(`到期`/`學習中`/`新卡`,accent 細邊框)。卡片本體用 `<AnkiCardView />`。

**Step 3 — 完成畫面**(`question === null`,風格對照 `AnkiDeck.tsx:196-205`):
```tsx
<div className="bg-white dark:bg-ink-800 border border-ink-200 dark:border-ink-700 rounded-lg p-8 sm:p-10 text-center shadow-paper">
  <Check size={28} className="mx-auto text-accent mb-3" />
  <h2 className="font-serif text-2xl text-ink-900 dark:text-ink-100 mb-2">今天的複習做完了</h2>
  <p className="text-sm text-ink-500 dark:text-ink-400">
    {served > 0 && `本次完成 ${served} 張。`}
    {queue?.next_due_at ? `下一張 ${formatDueAt(queue.next_due_at)}` : ''}
    {queue?.new_remaining === 0 && queue.new_available > 0 &&
      `　今日新卡額度已用完(還有 ${queue.new_available} 張未學)。`}
  </p>
  <Link to="/review" className="mt-4 inline-block text-accent hover:text-accent-dark">回到複習模式 →</Link>
</div>
```

**Step 4:** `App.tsx` 在 `:171` 的 `/anki/:year` **之前**加 `<Route path="/due" element={<DueQueue />} />`(兩者並存),並在檔頭 import(比照 `:43`)。

**Step 5:** `pnpm exec tsc --noEmit`;`cd frontend && pnpm build`;手測連做 5 張,確認第 4 張是新卡、清空後出現完成畫面。

**Step 6:** `git commit -m "feat(due): /due unified cross-year review queue page"`

### Task 3.3: 首頁與 `/review` 的到期 badge

**Files:** Modify `frontend/src/routes/Home.tsx`、`frontend/src/routes/ReviewIndex.tsx`

**Step 1:** `Home.tsx:49-55` 的 `useEffect` 加 `api.get<DueSummary>('/api/review/due').then(setDue).catch(() => setDue(null));`

**Step 2:** 倒數卡片下方插入 CTA(`due_total === 0` 時改顯示低調的「今天沒有到期卡片」文字):
```tsx
{due && due.due_total > 0 && (
  <Link to="/due" className="flex items-center justify-between gap-3 rounded-lg border border-accent/30 bg-accent/5 dark:bg-accent/15 px-4 py-3 hover:border-accent transition">
    <span className="text-ink-800 dark:text-ink-100">
      今天 <span className="font-mono text-accent text-lg">{due.due_total}</span> 張到期
    </span>
    <span className="text-xs text-ink-500 dark:text-ink-400">
      到期 {due.due_review} · 學習中 {due.learning} · 新卡 {due.new_remaining} →
    </span>
  </Link>
)}
```

**Step 3:** `ReviewIndex.tsx` 同樣抓 `/api/review/due`,CTA 放在「隨機抽一題開始」按鈕(`:86-91`)旁;年度卡片(`:114` 起的 `years.map`)以 `by_year` 加小 badge `{n} 張到期`(accent 文字、無底色,避免與既有進度條打架)。

**Step 4:** `cd frontend && pnpm build`;確認手機寬度 CTA 不溢出。

**Step 5:** `git commit -m "feat(due): due-today badges on home and review index"`

### Task 4.1: 效能查核(預期不產生 migration)

**Files:** 僅驗證;除非 `EXPLAIN` 不合格才 Create `migrations/0023_*.sql`

**Step 1:** `ls migrations/ | sort | tail -1` → 預期 `0022_highlights.sql`(若已非此值,新檔號往後推)。

**Step 2:**
```bash
DB=$(node scripts/lib/cfg.mjs project.d1_db)
wrangler d1 execute "$DB" --local --command "EXPLAIN QUERY PLAN SELECT * FROM fsrs_cards WHERE user_email='x' AND due_at <= 9999999999999 ORDER BY due_at LIMIT 1"
wrangler d1 execute "$DB" --local --command "EXPLAIN QUERY PLAN SELECT COUNT(*) FROM fsrs_review_logs WHERE user_email='x' AND reviewed_at >= 0 AND state = 0"
```
Expected:分別命中 `idx_fsrs_cards_due`(`migrations/0012_fsrs_anki.sql:27`)與 `idx_fsrs_logs_user_reviewed`(`:50`)。

**Step 3:** 僅在第一支顯示 `SCAN fsrs_cards` 時新增 `migrations/0023_fsrs_due_state_index.sql`:
```sql
-- 讓「跨年份、依 state 分流的到期查詢」不必回表過濾 state
CREATE INDEX IF NOT EXISTS idx_fsrs_cards_due_state ON fsrs_cards(user_email, state, due_at);
```
接著 `pnpm db:migrate:local`。**否則本 task 不產生 migration。**

**Step 4:** `git commit --allow-empty -m "chore(due): verify fsrs_cards index coverage for cross-year queue"`

---

## 驗收清單

- [ ] `pnpm test` 全綠,含 `due-window.test.ts`(邊界、跨日、未來卡、新卡)與 `queue-mix.test.ts`(交錯、額度、清空)。
- [ ] `pnpm exec tsc --noEmit` 與 `cd frontend && pnpm build` 皆無錯。
- [ ] `GET /api/review/due` 的 `due_total === learning + due_review + new_remaining`。
- [ ] 凌晨 3 點打開 `/due` 顯示「昨天那一批」;凌晨 4 點後才換批。
- [ ] 連續作答時第 4、8、12 張是新卡;新卡做滿 20 張後不再出現,`new_remaining === 0`。
- [ ] 佇列清空顯示完成畫面與 `next_due_at`,不是空白頁或無限 loading。
- [ ] `/anki/113` 行為與改動前逐字一致(deck 統計、排序、無新卡上限)。
- [ ] badge 數字與 `/api/review/due` 一致;`due_total === 0` 時不顯示大 CTA。
- [ ] 未新增 migration(或僅新增 `0023`,且是 `CREATE INDEX IF NOT EXISTS`)。

## 風險與回滾

| 風險 | 影響 | 緩解 / 回滾 |
| --- | --- | --- |
| `fsrs_review_logs.state` 不是「複習前」狀態 | 今日新卡計數錯誤,額度失效 | Task 2.1 Step 3 已排定 D1 驗證;不成立則改用 `fsrs_cards.created_at` 計數 |
| 日界被誤解為「卡片被延後」 | 使用者困惑 | 完成畫面明寫下一張時間;`day_start_hour` 由 API 回傳、前端顯示而非硬編 |
| Task 3.1 重構意外改動 `/anki/:year` 視覺 | 既有入口退化 | 該 task 純搬移、獨立 commit,`git revert` 即可;驗收清單有逐字比對項 |
| 新卡交錯比例不合胃口 | 節奏不佳 | `?new_limit=` 可覆寫;`NEW_EVERY` 集中一處,改一行 |
| 兩個入口同時開著互相搶卡 | 同卡被排程兩次 | 寫入端點未變,FSRS upsert 對「最後一次評分」冪等,不需額外處理 |

**整體回滾:** 改動集中在 `worker/lib/due-window.ts`、`worker/lib/queue-mix.ts`、`worker/routes/review.ts` 的新增區段、`frontend/src/routes/DueQueue.tsx` 與兩處 badge。`git revert` Task 2.1 之後的 commit 即回到現況,無資料需回捲。

## 成本

**$0 增量。** 無新 Cloudflare 資源(不用 Vectorize / KV / DO / Workers AI),預設路徑無新 migration。每次開頁 3 支 index-covered 的 D1 讀取,20 人 × 每天數十次 ≈ 每日數千列讀,遠低於 D1 free tier 的 500 萬列/日。`fsrs_cards` 上限 1000 題 × 20 人 = 20 000 列。

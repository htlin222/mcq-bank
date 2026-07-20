# 每週讀書目標與進度預估 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 把「活動 heatmap」與「考試倒數」接起來,讓使用者在首頁一眼看到「以我目前的速度,考前做得完嗎」。核心產出是首頁一張 pacing 卡片:剩餘天數 × 已完成題數 × 本週進度 × 近 7 天速度 × 預估完成日,落後時給具體的「每天 N 題就能追上」。

**Architecture:** 一張極簡 D1 表只存「每週目標」;進度一律從既有作答資料即時計算(不建第二個真相來源)。所有算術抽成 `worker/lib/pacing.ts` 純函式,先寫失敗測試;route 只負責取數 + 呼叫純函式。考試日期由 `config.toml [exam].date_iso` 鏡射進 `wrangler.toml [vars]`,worker 才讀得到(worker 無 FS,不能讀 config.toml)。

**Tech Stack:** Cloudflare Workers (Hono) + D1 (SQLite),無新增服務。前端 React 18 + Vite + Tailwind。測試 `node --test`(`node:test` + `node:assert/strict`),沿用 `package.json:26` 的 `node --test 'worker/**/*.test.ts'`。

---

## 現況(file:line 佐證,實作前請自行覆核)

- **活動資料**:`worker/routes/review.ts:307` `GET /heatmap`,把 `review_progress.last_seen_at`、`fsrs_review_logs.reviewed_at`、`exam_answers.answered_at` 三來源 UNION,再以 `strftime('%Y-%m-%d', ts / 1000, 'unixepoch', '+8 hours')`(`worker/routes/review.ts:326`)分到 UTC+8 的日子。**這就是本計畫的每日速度來源,不要另寫一套。**
- **完成度**:`worker/routes/review.ts:559` `GET /stats`,`questions_attempted` 來自 `SELECT COUNT(*) FROM review_progress WHERE user_email = ? AND times_seen > 0`(`worker/routes/review.ts:562`)。pacing 的「已完成」沿用同一定義,兩張卡才不會打架。
- **倒數**:`frontend/src/routes/Home.tsx:21` `const EXAM_DATE = new Date(config.exam.date_iso)`,`config` 來自 `frontend/src/config.ts`(`export const config: AppConfig = __APP_CONFIG__`),而 `__APP_CONFIG__` 由 `frontend/vite.config.ts:86` 的 `define` 於 build time 由 `config.toml` 注入。倒數卡片本身在 `frontend/src/routes/Home.tsx:91-126`,heatmap + 統計在 `:128-143`。
- **考試日設定**:`config.example.toml` 的 `[exam] date_iso / date_label / countdown_label`;型別在 `frontend/src/config.ts:18`。**worker 目前完全讀不到它** —— `wrangler.toml:68` 的 `[vars]` 沒有 exam 相關 key。
- **schema**:`migrations/0001_initial_schema.sql:128-141` 的 `review_progress`(PK `(user_email, question_id)`,含 `times_seen`/`times_correct`/`last_seen_at`);`migrations/0012_fsrs_anki.sql` 的 `fsrs_review_logs`(`idx_fsrs_logs_user_reviewed` 已覆蓋 `(user_email, reviewed_at DESC)`,速度查詢走得到索引)。
- **migration 編號**:`migrations/` 目前最後一支是 `0022_highlights.sql`,**下一號是 0023**(原需求寫的 0026 是舊資訊;實作前請再 `ls migrations/` 覆核一次)。
- **複習首頁**:`frontend/src/routes/ReviewIndex.tsx:93-103` 已有一個統計 section(內含 `ConfidenceCalibration`),是 pacing 卡片的第二順位落點。
- **前端 API wrapper**:`frontend/src/lib/api.ts:43-53` 已有 `api.get` / `api.put`。

---

## 設計立場(這節請照抄進 code comment 與 PR 說明)

**做每週目標,不做 daily streak。** streak 的失敗模式很明確:漏一天就歸零,而歸零對成年在職考生(值班、家庭、突發)是**棄坑觸發器**而非動力來源。每週目標保留「週三沒讀、週六補回來」的補救空間,同時仍然服務 distributed practice —— Dunlosky 2013 認定的兩個 high-utility 技巧之一(另一個是 practice testing,本 repo 的 FSRS 已在做)。分佈練習要的是「一週內有多次分散的接觸」,週目標足以表達這件事,不需要連續性懲罰。

**不做排行榜、積分、徽章。** 這是 20 人的熟人圈,公開排名對落後的人是壓力、對領先的人是噪音,而且會誘導「刷題數」而非「讀懂」。所有 pacing 數字**只有自己看得到**(per-user query,一律 `c.var.email`)。

**不另存進度快照。** 進度即時從 `review_progress` / `fsrs_review_logs` / `exam_answers` 算。理由是避免第二個真相來源 —— 一旦快取進度,任何回填、匯入、刪題都會讓兩邊漂移,而漂移的症狀(卡片數字跟 heatmap 不一致)極難除錯。

**成本權衡(若日後想快取):** 本 API 每次是 2 個 `COUNT(*)` + 一個 28 天的 `GROUP BY`(有索引),對 D1 free tier 的每日 read rows 額度而言可忽略(20 人 × 每日數十次)。真要快取只該用 `Env.CACHE`(KV,`worker/types.ts:13` 已宣告為 optional)存 60 秒,但代價是「剛做完 10 題,卡片沒動」——那會被當成 bug。**結論:先不快取**,除非 `wrangler tail` 真的看到延遲。

## 非目標

- 不做通知 / 推播 / email 提醒(現有 `notifications` 表不動)。
- 不做群體統計、不做「你比 X 快」。
- 不改 FSRS 排程,不改 heatmap 的既有回傳格式。
- 不做每日目標、不做連續天數(streak)欄位 —— 見上。
- 不做多輪規劃(第二輪、第三輪);本版只預估「第一輪跑完」。

## 跨切面約定

- Auth 一律 `c.var.email`(Cloudflare Access 已驗過),route 內不得接受 email 參數。
- migration 只新增不改已套用檔。
- per-fork 設定走 `config.toml`,禁止 hard-code 考試日期 / slug / host。
- 時區:全系統的「一天」= UTC+8(Asia/Taipei),與 `worker/routes/review.ts:326` 一致。**純函式不做時區換算**,只吃 `YYYY-MM-DD` 字串,時區只在 SQL 與一個 `todayInTaipei()` helper 裡出現。
- 「一週」= 週一 00:00 (UTC+8) 起、週日 23:59:59 止。這是明確定義,且必須有測試。
- 測試檔與原始碼同目錄 `*.test.ts`。每個 task 能獨立 commit。
- UI:scholarly/editorial,ink/cream + `accent`(#a8442a);Tailwind `accent` 只有 `DEFAULT`/`dark`/`light`,不得用 `accent-600` 這種不存在的階;無漸層、無玻璃擬態。

---

### Task 1.1: 把考試日期送進 Worker

**Files:**
- Modify: `wrangler.example.toml`(`[vars]` 區塊,GROUPS 之後)
- Modify: `wrangler.toml`(同位置,填實際值)
- Modify: `scripts/setup.sh`(第 129 行附近取值、第 169 行附近 `keysub`)
- Modify: `worker/types.ts`(`Env` 加欄位)

**Step 1:** `wrangler.example.toml` 與 `wrangler.toml` 的 `[vars]` 加:
```toml
# 考試開始時間 — 由 setup.sh 從 config.toml [exam].date_iso 鏡射。
# review/pacing 用它算「考前還剩幾天」;未設時 pacing 回 days_left: null。
EXAM_DATE_ISO = "2026-12-31T09:00:00+08:00"
```
(`wrangler.example.toml` 用 config.example.toml 的同一個佔位日期。)

**Step 2:** `scripts/setup.sh` 在既有 `GROUPS_LIST=$(cfg groups.list)` 旁加 `EXAM_DATE_ISO=$(cfg exam.date_iso)`,把它加進 python heredoc 的參數列,並加一行 `keysub('EXAM_DATE_ISO', exam_date_iso)`。**照抄現有 GROUPS 的寫法**,不要另發明機制。

**Step 3:** `worker/types.ts` 的 `Env` 在 `GROUPS?: string;` 附近加:
```ts
  // 考試開始時間 (ISO-8601 with offset) — 鏡射自 config.toml [exam].date_iso。
  // 未設時 /api/review/pacing 回 days_left: null,前端退化為只顯示速度。
  EXAM_DATE_ISO?: string;
```

**驗證:** `pnpm exec tsc --noEmit` 過;`grep EXAM_DATE_ISO wrangler.toml` 有值。

```bash
git add wrangler.toml wrangler.example.toml scripts/setup.sh worker/types.ts
git commit -m "feat(config): mirror exam date into worker vars for pacing"
```

### Task 1.2: migration 0023 — study_goals

**Files:**
- Create: `migrations/0023_study_goals.sql`

**Step 1:** 先 `ls migrations/` 確認最後一號仍是 `0022_highlights.sql`;若已有人加了新 migration,順延編號。

**Step 2:** 寫檔:
```sql
-- ============================================================
-- Migration 0023: 每週讀書目標 (study goals)
--
-- 只存「每週題數目標」一個值。進度本身刻意不存 —— 一律從
-- review_progress / fsrs_review_logs / exam_answers 即時算,避免第二個
-- 真相來源(見 docs/plans/2026-07-20-study-goals-and-pacing.md)。
-- 沒有 row = 尚未設定,API 依剩餘題數/天數給建議預設值。
-- 刻意不做 streak / 排行榜欄位。
-- ============================================================

CREATE TABLE study_goals (
  user_email    TEXT    PRIMARY KEY REFERENCES users(email) ON DELETE CASCADE,
  weekly_target INTEGER NOT NULL,          -- 每週目標題數,1..1000
  updated_at    INTEGER NOT NULL           -- epoch ms
);
```

**驗證:**
```bash
pnpm db:migrate:local
wrangler d1 execute $(node scripts/lib/cfg.mjs project.d1_db) --local \
  --command "SELECT name FROM sqlite_master WHERE name='study_goals'"
```
Expected: 回一列 `study_goals`。

```bash
git add migrations/0023_study_goals.sql
git commit -m "feat(goals): study_goals table for weekly study target"
```

### Task 2.1: pacing 純函式(TDD)

**Files:**
- Create: `worker/lib/pacing.ts`
- Test: `worker/lib/pacing.test.ts`

介面(全部是純資料進、純資料出,不碰 D1、不碰 `Date.now()`):
```ts
export type DayCount = { d: string; n: number };   // d = 'YYYY-MM-DD' (UTC+8)
export type PacingInput = {
  daily: DayCount[];        // 近 N 天的每日完成題數(可有缺日)
  today: string;            // 'YYYY-MM-DD',UTC+8 的今天
  totalQuestions: number;
  completed: number;
  daysLeft: number | null;  // 距考試天數;null = 未設考試日
  weeklyTarget: number;
};
```

**Step 1 — 失敗測試** `worker/lib/pacing.test.ts`(至少涵蓋以下 case):
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { computePacing, startOfWeek, suggestWeeklyTarget } from "./pacing.ts";

const base = { totalQuestions: 1000, completed: 660, daysLeft: 41, weeklyTarget: 100 };

test("週一為一週起點;週日屬於前一個週一", () => {
  assert.equal(startOfWeek("2026-07-20"), "2026-07-20"); // 週一
  assert.equal(startOfWeek("2026-07-19"), "2026-07-13"); // 週日 → 上週一
  assert.equal(startOfWeek("2026-07-22"), "2026-07-20");
});

test("典型情境:本週進度、近 7 天速度、預估完成日與緩衝天數", () => {
  const daily = Array.from({ length: 7 }, (_, i) => ({
    d: `2026-07-${String(14 + i).padStart(2, "0")}`, n: 18,
  }));
  const r = computePacing({ ...base, daily, today: "2026-07-20" });
  assert.equal(r.recent_rate, 18);
  assert.equal(r.remaining, 340);
  assert.equal(r.days_to_finish, 19);        // ceil(340 / 18)
  assert.equal(r.buffer_days, 22);           // 41 - 19
  assert.equal(r.on_track, true);
  assert.equal(r.needed_per_day, 9);         // ceil(340 / 41)
});

test("零活動:不可除以零、不可回 Infinity", () => {
  const r = computePacing({ ...base, daily: [], today: "2026-07-20" });
  assert.equal(r.recent_rate, 0);
  assert.equal(r.days_to_finish, null);      // 不是 Infinity
  assert.equal(r.buffer_days, null);
  assert.equal(r.on_track, false);
  assert.equal(Number.isFinite(r.needed_per_day), true);
  assert.equal(r.week_done, 0);
});

test("跨週邊界:上週日的題數不算進本週", () => {
  const daily = [{ d: "2026-07-19", n: 50 }, { d: "2026-07-20", n: 5 }];
  const r = computePacing({ ...base, daily, today: "2026-07-20" });
  assert.equal(r.week_done, 5);
  assert.equal(r.week_start, "2026-07-20");
});
```
其餘必寫(同樣風格):
- **已完成全部**(`completed: 1000`)→ `remaining 0` / `needed_per_day 0` / `done true` / `on_track true`。
- **考試日已過**(`daysLeft: -3`)→ `days_left` clamp 到 `0`,`needed_per_day` 用 `max(daysLeft,1)` 當除數故為 `340`(不得 `Infinity`),`on_track false`。
- **未設考試日**(`daysLeft: null`)→ `days_left`/`on_track`/`needed_per_day` 皆 `null`,但速度與本週進度照常。
- **剛好達標**(本週 100、目標 100)→ `week_met true`、`week_pct 100`(用 `>=` 不是 `>`)。
- **速度視窗**:`daily` 含 `2026-06-01: 700` 與 `2026-07-20: 7`,`recent_rate` 必須是 `1`(只看 today 往回 7 天)。
- **`suggestWeeklyTarget(remaining, daysLeft)`**:攤平後 clamp 到 `[10, 300]`;取整規則由實作定義(建議四捨五入到最近的 10)並在測試中鎖死,不留未定義行為。

**Step 2:** `node --test worker/lib/pacing.test.ts` → FAIL(找不到模組)。

**Step 3 — 實作** `worker/lib/pacing.ts`。要點:
- `startOfWeek(day)`:用 `new Date(day + 'T00:00:00Z')` 純 UTC 運算(day 字串已經是 UTC+8 的日期,不再做偏移),`getUTCDay()` 0=週日 → `offset = (dow + 6) % 7`,回推得週一。
- `recent_rate` = 近 7 天(含 today)總題數 / 7,四捨五入到小數 1 位;分母固定 7,**不用「有活動的天數」**,否則久沒讀反而顯示高速度。
- `days_to_finish` = `recent_rate > 0 ? Math.ceil(remaining / recent_rate) : null`;`remaining === 0` 時為 `0`。
- `buffer_days` = `days_left != null && days_to_finish != null ? days_left - days_to_finish : null`。
- `needed_per_day` = `days_left == null ? null : Math.ceil(remaining / Math.max(days_left, 1))`。
- `on_track` = `days_left == null ? null : (remaining === 0 || (days_to_finish != null && days_to_finish <= days_left))`。
- 全部輸出欄位在無資料時給 `0` 或 `null`,**任何路徑都不得產生 `Infinity` / `NaN`**;實作完在函式尾端加一個 dev-only assert 也可。

**Step 4:** `node --test worker/lib/pacing.test.ts` → PASS。

```bash
git add worker/lib/pacing.ts worker/lib/pacing.test.ts
git commit -m "feat(pacing): pure readiness-pacing calculator with TZ-safe week math"
```

### Task 2.2: 抽出每日活動查詢 helper

**Files:**
- Create: `worker/lib/activity.ts`
- Modify: `worker/routes/review.ts`(改寫 `GET /heatmap`,`:307-337`)

**Step 1:** 把 `worker/routes/review.ts:315-334` 的 UNION + `strftime(... '+8 hours')` 查詢原封不動搬進 `worker/lib/activity.ts`:
```ts
export const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000;

/** UTC+8 的今天,'YYYY-MM-DD'。與 SQL 的 '+8 hours' 修飾子同一套曆法。 */
export function todayInTaipei(nowMs: number): string {
  return new Date(nowMs + TAIPEI_OFFSET_MS).toISOString().slice(0, 10);
}

/** 每日完成題數(review + FSRS + exam 三來源),依 UTC+8 分日。SQL 搬自 review.ts。 */
export async function dailyActivity(
  db: D1Database, email: string, sinceMs: number,
): Promise<{ d: string; n: number }[]>
```

**Step 2:** `GET /heatmap` 改成呼叫 `dailyActivity`,**回傳格式一字不改**(前端 `ActivityHeatmap.tsx` 不動)。

**Step 3:** 為 `todayInTaipei` 補測試 `worker/lib/activity.test.ts`:UTC 2026-07-19T17:00Z → `2026-07-20`(台北已跨日);UTC 2026-07-19T15:59Z → `2026-07-19`。**這是「半夜跳日」的回歸測試,不可省。**

**驗證:** `node --test 'worker/**/*.test.ts'` 全綠;本地開 `pnpm dev` 看首頁 heatmap 與改動前一致。

```bash
git add worker/lib/activity.ts worker/lib/activity.test.ts worker/routes/review.ts
git commit -m "refactor(review): extract dailyActivity helper shared by heatmap and pacing"
```

### Task 2.3: pacing / goal API

**Files:**
- Modify: `worker/routes/review.ts`(在 `GET /stats`(`:559`)附近新增兩支)

**Step 1 — `GET /api/review/pacing`:**
```ts
reviewRoutes.get("/pacing", async (c) => {
  const email = c.var.email;
  const now = Date.now();

  const [total, done, goal] = await Promise.all([
    c.env.DB.prepare("SELECT COUNT(*) AS n FROM questions").first<{ n: number }>(),
    c.env.DB.prepare(   // 與 GET /stats (review.ts:562) 同一個定義,兩張卡才不打架
      "SELECT COUNT(*) AS n FROM review_progress WHERE user_email = ? AND times_seen > 0",
    ).bind(email).first<{ n: number }>(),
    c.env.DB.prepare("SELECT weekly_target FROM study_goals WHERE user_email = ?")
      .bind(email).first<{ weekly_target: number }>(),
  ]);

  // 28 天視窗:近 7 天算速度,其餘留給前端畫趨勢(可選)。
  const daily = await dailyActivity(c.env.DB, email, now - 28 * 86_400_000);

  // 考試日:worker 讀不到 config.toml,值由 setup.sh 鏡射進 [vars](Task 1.1)。
  const examMs = c.env.EXAM_DATE_ISO ? Date.parse(c.env.EXAM_DATE_ISO) : NaN;
  const daysLeft = Number.isFinite(examMs) ? Math.ceil((examMs - now) / 86_400_000) : null;

  const totalQ = total?.n ?? 0;
  const completed = done?.n ?? 0;
  const weeklyTarget = goal?.weekly_target
    ?? suggestWeeklyTarget(Math.max(totalQ - completed, 0), daysLeft ?? 90);

  return c.json({
    ...computePacing({
      daily, today: todayInTaipei(now),
      totalQuestions: totalQ, completed, daysLeft, weeklyTarget,
    }),
    weekly_target: weeklyTarget,
    weekly_target_is_default: !goal,
  });
});
```
> 時區重點:`days_left` 用 `Math.ceil` 對「毫秒差」取整,所以它是「還有幾個 24 小時」,與首頁倒數(`Home.tsx:34` 的 `Math.floor`)可能差 1 天。**卡片文案一律用 API 回的 `days_left`,不要混用前端倒數的 `days`**,否則同一張畫面出現兩個天數。

**Step 2 — `PUT /api/review/goal`:**
```ts
reviewRoutes.put("/goal", async (c) => {
  const email = c.var.email;
  const body = await c.req.json<{ weekly_target?: number }>();
  const t = Math.trunc(Number(body.weekly_target));
  if (!Number.isFinite(t) || t < 1 || t > 1000) {
    return c.json({ error: "weekly_target must be 1..1000" }, 400);
  }
  await c.env.DB.prepare(
    `INSERT INTO study_goals (user_email, weekly_target, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(user_email) DO UPDATE SET weekly_target = excluded.weekly_target,
                                           updated_at = excluded.updated_at`,
  ).bind(email, t, Date.now()).run();
  return c.json({ ok: true, weekly_target: t });
});
```

**驗證:**
```bash
pnpm dev   # 另一個 terminal
curl -s -H "X-Dev-Email: $(node scripts/lib/cfg.mjs dev.dev_email)" \
  localhost:8787/api/review/pacing | jq
curl -s -X PUT -H "Content-Type: application/json" \
  -H "X-Dev-Email: $(node scripts/lib/cfg.mjs dev.dev_email)" \
  -d '{"weekly_target":100}' localhost:8787/api/review/goal | jq
```
Expected: 第一支回含 `days_left` / `recent_rate` / `week_done` 的物件且無 `null` 以外的異常值;第二支回 `{ok:true}`,再打第一支看到 `weekly_target_is_default: false`。
> 若 API 全部 500/404,先確認 8787 沒被 OpenEvidence MCP relay 佔走(已知坑)。

```bash
git add worker/routes/review.ts
git commit -m "feat(review): pacing + weekly goal endpoints"
```

### Task 3.1: 首頁 pacing 卡片

**Files:**
- Create: `frontend/src/components/PacingCard.tsx`
- Modify: `frontend/src/routes/Home.tsx`(插在倒數 section 之後、heatmap section 之前,即 `:126` 與 `:128` 之間)

**Step 1:** `PacingCard.tsx` 以 `api.get('/api/review/pacing')` 取數,載入中顯示骨架(固定高度,避免 CLS)。版面:
- 第一行(細字、`text-ink-500`):`距考試 41 天 · 已完成 660 / 1000 題`
- 第二行(主角):`本週 85 / 100 題` + 一條 `h-1.5 bg-ink-100 dark:bg-ink-700` 底、`bg-accent` 前景的進度條(`width: min(100, week_pct)%`)。
- 第三行(結論句,見 Step 2)。
- 容器沿用既有卡片語彙:`bg-white dark:bg-ink-800 border border-ink-200 dark:border-ink-700 rounded-lg p-5 shadow-paper`。**不要漸層、不要 blur。**

**Step 2 — 文案規則(具體、不責備):**
```ts
function verdict(p: Pacing): string {
  if (p.done) return '第一輪已完成 — 接下來交給 FSRS 複習排程。';
  if (p.recent_rate === 0) return '這週還沒開始 — 先做 10 題暖身,速度算得出來卡片就會更新。';
  if (p.days_left == null) return `近 7 天平均 ${p.recent_rate} 題/天,依此速度還需 ${p.days_to_finish} 天完成第一輪。`;
  if (p.on_track) return `依近 7 天速度(平均 ${p.recent_rate} 題/天),預計考前 ${p.buffer_days} 天完成第一輪。`;
  return `每天 ${p.needed_per_day} 題就能在考前跑完第一輪(近 7 天平均 ${p.recent_rate} 題/天)。`;
}
```
落後時**只講需要的每日題數**,不出現「你落後了 / 進度不足 / 警告」等字眼;顏色用 `text-ink-600`,最多在數字上用 `text-accent`,**不用紅色**。

**Step 3:** `Home.tsx` 加 `import { PacingCard } from '../components/PacingCard';`,在倒數 `</section>` 之後放 `<section className="mb-8"><PacingCard /></section>`。

**驗證:** `cd frontend && pnpm build` 過;本地首頁看到卡片,手動做幾題後重整數字會動;窄螢幕(375px)不橫向捲動。

```bash
git add frontend/src/components/PacingCard.tsx frontend/src/routes/Home.tsx
git commit -m "feat(ui): home readiness pacing card"
```

### Task 3.2: 每週目標設定 UI

**Files:**
- Modify: `frontend/src/components/PacingCard.tsx`

**Step 1:** 卡片右上角一個小按鈕(lucide `Settings2`,`size={16}`,`text-ink-400 hover:text-accent`,`aria-label="設定每週目標"`)。點下切換成 inline 編輯列:`<input type="number" min={1} max={1000}>` + 「儲存」「取消」。

**Step 2:** 儲存呼叫 `api.put('/api/review/goal', { weekly_target })`,成功後重新 `api.get('/api/review/pacing')` 更新卡片(不要只改本地 state —— `week_pct` / `week_met` 是後端算的)。失敗顯示 inline 錯誤文字,不用 alert。

**Step 3:** 尚未設定過目標時(`weekly_target_is_default`),在目標數字旁加一個灰字 `建議值`,點設定即可覆寫。這讓「預設從哪來」對使用者是可見的。

**驗證:** 設 50 → 卡片本週百分比重算;設 0 或 9999 → 後端 400,前端顯示錯誤而不崩;重整後值仍在(跨裝置,因為存 D1 不是 localStorage)。

```bash
git add frontend/src/components/PacingCard.tsx
git commit -m "feat(ui): inline weekly goal editor on pacing card"
```

---

## 驗收清單

- [ ] `node --test 'worker/**/*.test.ts'` 全綠,含零活動 / 速度 0 / 全部完成 / 考試日已過 / 剛好達標 / 跨週邊界 / 半夜跳日七組邊界測試。
- [ ] `pnpm exec tsc --noEmit` 與 `cd frontend && pnpm build` 皆過。
- [ ] `GET /api/review/pacing` 在**全新使用者**(零作答、無 study_goals row)不回 `Infinity` / `NaN` / `null` 以外的破值,前端卡片正常渲染。
- [ ] 卡片的「已完成 N 題」與 `/api/review/stats` 的 `questions_attempted` 一致(同一個 SQL 定義)。
- [ ] 卡片的每日速度與 heatmap 同一天的格子數量對得起來(共用 `dailyActivity`)。
- [ ] `GET /heatmap` 回傳格式與重構前逐字節相同(`ActivityHeatmap.tsx` 未改)。
- [ ] 台北時間 00:30 重整頁面,「本週」不會提前或延後跳一天(可用改系統時鐘或直接對 `todayInTaipei` 下測試驗證)。
- [ ] 全站沒有出現任何排行榜、積分、徽章、連續天數。
- [ ] 未設 `EXAM_DATE_ISO` 時 worker 不炸,卡片退化成只顯示速度與本週進度。

## 風險與回滾

- **`days_left` 與首頁倒數差 1 天**(ceil vs floor):最可能的體感 bug。緩解 = 卡片一律用 API 的 `days_left`;若使用者反映不一致,把倒數卡也改用同一個值,不要兩邊各自算。
- **Task 2.2 動到既有 `/heatmap`**:純重構,風險在 SQL 搬運時打錯字。回滾 = `git revert` 該 commit,heatmap 與 pacing 各自查一次(重複 SQL,可接受的暫時狀態)。
- **`suggestWeeklyTarget` 的預設值不合理**(例如剩餘題數大而天數少 → 建議值頂到 300):這是資訊而非強制,使用者可覆寫;上限 clamp 就是為了不給出羞辱性的數字。
- **回滾整個功能**:`revert` Task 3.x + 2.3 即可;`study_goals` 表留著無害(migration 不回頭改)。

## 成本

零新增服務。每次 `GET /pacing` = 2 個 `COUNT(*)` + 一個 28 天視窗的 UNION/GROUP BY(走 `idx_rp_user`、`idx_fsrs_logs_user_reviewed`);20 人日常使用遠低於 D1 free tier 的每日讀取額度。無 Workers AI、無 Vectorize、無 KV 寫入。完全落在 Cloudflare free tier。

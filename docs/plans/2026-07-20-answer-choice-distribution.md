# 選項分布統計 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 使用者作答後,在每個選項上顯示「全體有多少比例選這個」——例如「62% 選 B、21% 選 A」,並標出**你的選擇**與**正解**。把「我答錯了」轉成「我掉進哪個 distractor、多少人跟我一起掉」。複習模式(`QuestionCard`)與模擬考檢討頁(`ExamResult`)都要看得到。

**Architecture:** 資料早就在庫裡,**不需要新表**。兩個既有來源合併成「一人一票」:

```
review_progress.last_chosen  ─┐
  (每人每題最新一次選擇)       ├─→ tallyChoices()  ─→ GET /api/questions/:id/stats
exam_answers.chosen          ─┘   (worker/lib/           { choices, responders,
  (已結束的模擬考作答)              choiceStats.ts)         choices_state }
                                   純函式・可測             ↓
                                                    QuestionCard / ExamResult
                                                    選項底色百分比長條
```

Worker 端只多兩個 SELECT + 一個純函式;前端只多幾個 div,不新增 request(`/:id/stats` 已經在答案揭曉時 lazy fetch,見 `frontend/src/components/QuestionCard.tsx:55-63`)。

**Tech Stack:** Cloudflare Workers (Hono) + D1。前端 React 18 + Vite + Tailwind。測試 `node --test`(`node:test` + `node:assert/strict`,`.ts` 直接 import,見 `worker/lib/calibration.test.ts:1-3`);`pnpm test` = `node --test 'worker/**/*.test.ts'`(`package.json:26`)。無新增服務,全部落在 Cloudflare free tier。

---

## 現況(已實地確認,附 file:line)

**1. 既有跨使用者統計端點** — `worker/routes/questions.ts:453-472`
```
GET /api/questions/:id/stats
SELECT SUM(times_seen) attempts, SUM(times_correct) correct, COUNT(*) responders
FROM review_progress WHERE question_id = ? AND times_seen > 0
```
回 `{ attempts, correct, responders, accuracy }`。註解已聲明「no identity exposed」(`worker/routes/questions.ts:449-451`),本計畫延續同一原則。**目前沒有任何 gating** —— 任何人都能讀,包括還沒作答的人。

**2. `review_progress.last_chosen` 確實被寫入** — `worker/routes/review.ts:101-133` 的 `answerProgressOp()`,INSERT 與 `ON CONFLICT ... DO UPDATE SET last_chosen = ?` 兩路都綁 `args.chosen`。呼叫點有兩處:
- `POST /api/review/answer` — `worker/routes/review.ts:136-174`(第 153 行)
- `POST /api/review/anki/review`(FSRS 評分,`chosen` 為選填)— `worker/routes/review.ts:531-545`

欄位定義:`migrations/0001_initial_schema.sql:128-139`,`last_chosen TEXT`(第 134 行),PK `(user_email, question_id)` —— **天然就是「每人每題一票、取最新」**。清除紀錄會刪整列(`worker/routes/review.ts:298`),等同撤票,合理。

**3. 模擬考路徑不寫 `last_chosen`**(已確認):`POST /api/exam/:sid/answer` 只 `UPDATE exam_answers SET chosen = ?, answered_at = ?`(`worker/routes/exam.ts:232-239`);`POST /api/exam/:sid/finish` 只回填 `is_correct` 與 `correct_answer_at_finish`(`worker/routes/exam.ts:263-273`);全檔沒有 `review_progress` 字樣。

`exam_answers` 定義於 `migrations/0001_initial_schema.sql:118-125`:`chosen TEXT`(可 NULL,表示未作答)、`is_correct`、`answered_at`,PK `(session_id, question_id)`,**沒有 `user_email` 欄**(要 JOIN `exam_sessions` 取)、**也沒有 `question_id` 上的索引**。

**決策(取代「補寫入」的修正 task):不改 exam 的寫入路徑。** 理由:全真作答刻意與複習進度隔離(考試中不揭曉答案、不影響 `times_seen`/FSRS 排程);讓 exam 反寫 `review_progress` 會污染複習統計與既有 `/stats` 的 `attempts`,屬於行為變更而非本功能所需。改為在**讀取端**把 `exam_answers` 當第二來源合併(Task 2),資訊完整度相同、零副作用。若日後真要統一寫入,做法是在 `worker/routes/exam.ts:263` 的 finish 交易裡 batch 一組 `answerProgressOp()` —— 屆時 `tallyChoices` 的去重邏輯已能吸收重複票,不需再改。

**4. 前端** — 選項渲染 `frontend/src/components/QuestionCard.tsx:294-350`(`revealed` 後 emerald 標正解、rose 標你的錯誤選擇);`options` 由 `LETTERS` 過濾出實際存在者(同檔 175-177);現有 stats 文字列(同檔 403-407);`revealed` 初值來自 `my_progress?.last_chosen`(同檔 23-25)。`Question.tsx` 只是掛載 `QuestionCard`(`frontend/src/routes/Question.tsx:730-735`),**不需改**。檢討頁逐題列 `frontend/src/routes/ExamResult.tsx:94-136`,`Result.answers` 型別在同檔 15-22。

**5. migration 現況:** 最後一號是 `migrations/0022_highlights.sql`,故本計畫的索引 migration 用 **0023**(委託單原寫 0028,實地確認後修正)。**實作前請再 `ls migrations/` 確認一次**,若已有人加號,順延取下一個未使用號碼。

---

## 非目標

- 不做「誰選了什麼」的具名揭露(20 人小群體,具名等同公開審判)。
- 不做時間序列 / 難度趨勢 / IRT 鑑別度。
- 不新增資料表、不改 exam 寫入行為、不改 FSRS。
- 不做即時推播;分布在頁面載入時取一次即可。

## 跨切面約定

- Auth 一律 `c.var.email`(Cloudflare Access 已驗過),不自行做身分邏輯。
- migration 只新增不改。
- 純邏輯先抽 `worker/lib/*.ts` 純函式 + 同目錄 `*.test.ts`,**先寫失敗測試**。
- UI:scholarly/editorial,ink/cream + 單一 accent(`#a8442a`,`frontend/tailwind.config.js:20-24`,只有 `DEFAULT`/`dark`/`light`)。長條一律用既有 ink 階或 `accent/xx` 透明度,**無漸層、無玻璃擬態**。
- 每個 Task 獨立 commit。

**匿名門檻:** `MIN_RESPONDERS = 5`。少於 5 人作答就不回分布(3 人時「67% 選 B」等於指名道姓)。常數定義在 `worker/lib/choiceStats.ts`,單一來源。

**洩題防護:** 未作答者不得取得分布 —— 分布本身洩漏答案傾向。gating 由 server 決定,前端不可繞過。

---

### Task 1.1: `tallyChoices` 純函式(TDD)

**Files:**
- Create: `worker/lib/choiceStats.ts`
- Test: `worker/lib/choiceStats.test.ts`

**Step 1 — 失敗測試** `worker/lib/choiceStats.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { tallyChoices, MIN_RESPONDERS } from "./choiceStats.ts";

const L = ["A", "B", "C", "D"];

test("一人一票:同使用者跨來源只算較新的那票", () => {
	const out = tallyChoices(
		[
			{ user: "a@x", chosen: "A", at: 100 },
			{ user: "a@x", chosen: "B", at: 200 }, // 較新 → 只算 B
			{ user: "b@x", chosen: "B", at: 50 }, { user: "c@x", chosen: "B", at: 50 },
			{ user: "d@x", chosen: "C", at: 50 }, { user: "e@x", chosen: "C", at: 50 },
		],
		{ letters: L, minResponders: 5 },
	);
	assert.equal(out.responders, 5);
	assert.deepEqual(out.counts, { A: 0, B: 3, C: 2, D: 0 });
	assert.equal(out.pct.B, 60);
	assert.equal(out.suppressed, false);
});

test("忽略未作答(null/空字串)與非法選項值", () => {
	const votes = [
		{ user: "a@x", chosen: null, at: 1 },
		{ user: "b@x", chosen: "  ", at: 1 },
		{ user: "c@x", chosen: "Z", at: 1 }, // 不在 letters
		{ user: "d@x", chosen: "E", at: 1 }, // 本題沒有 E
		{ user: "e@x", chosen: "b", at: 1 }, // 小寫 → 正規化成 B
		{ user: "f@x", chosen: " A ", at: 1 },
	];
	const out = tallyChoices(votes, { letters: L, minResponders: 2 });
	assert.equal(out.responders, 2);
	assert.deepEqual(out.counts, { A: 1, B: 1, C: 0, D: 0 });
});

test("低於匿名門檻 → suppressed,不吐 counts", () => {
	const out = tallyChoices(
		[{ user: "a@x", chosen: "A", at: 1 }, { user: "b@x", chosen: "B", at: 1 }],
		{ letters: L, minResponders: MIN_RESPONDERS },
	);
	assert.equal(out.suppressed, true);
	assert.equal(out.responders, 2);
	assert.equal(out.counts, null);
	assert.equal(out.pct, null);
});

test("零票:responders=0、suppressed=true、不除以零", () => {
	const out = tallyChoices([], { letters: L, minResponders: MIN_RESPONDERS });
	assert.deepEqual(out, { responders: 0, counts: null, pct: null, suppressed: true });
});

test("百分比四捨五入到 0.1,分母是 responders", () => {
	const votes = ["a", "b", "c"].map((u) => ({ user: u, chosen: "A", at: 1 }));
	votes.push({ user: "d", chosen: "B", at: 1 }, { user: "e", chosen: "B", at: 1 });
	votes.push({ user: "f", chosen: "C", at: 1 });
	const out = tallyChoices(votes, { letters: L, minResponders: 5 });
	assert.equal(out.responders, 6);
	assert.equal(out.pct.A, 50);
	assert.equal(out.pct.C, 16.7);
});

test("時間相同時取後出現者(來源順序即優先序)", () => {
	const out = tallyChoices(
		[{ user: "a", chosen: "A", at: 5 }, { user: "a", chosen: "D", at: 5 }],
		{ letters: L, minResponders: 1 },
	);
	assert.equal(out.counts!.D, 1);
	assert.equal(out.counts!.A, 0);
});
```

**Step 2:** `pnpm test` → FAIL(找不到模組)。

**Step 3 — 實作** `worker/lib/choiceStats.ts`:
```ts
/** 少於這個人數就不揭示分布 —— 20 人的讀書會裡,3 人的百分比等於指名道姓。 */
export const MIN_RESPONDERS = 5;

export type Vote = { user: string; chosen: string | null; at: number };

export type ChoiceStats = {
	responders: number;
	counts: Record<string, number> | null;
	pct: Record<string, number> | null;
	suppressed: boolean;
};

export function tallyChoices(
	votes: Vote[],
	opts: { letters: string[]; minResponders: number },
): ChoiceStats {
	const allowed = new Set(opts.letters);
	// 一人一票:同 user 取 at 較大者;at 相同時後者勝(呼叫端把較可信的來源放後面)。
	const latest = new Map<string, { chosen: string; at: number }>();
	for (const v of votes) {
		const c = (v.chosen ?? "").trim().toUpperCase();
		if (!c || !allowed.has(c)) continue;
		const prev = latest.get(v.user);
		if (prev && prev.at > v.at) continue;
		latest.set(v.user, { chosen: c, at: v.at });
	}

	const responders = latest.size;
	if (responders < opts.minResponders) {
		return { responders, counts: null, pct: null, suppressed: true };
	}

	const counts: Record<string, number> = {};
	for (const L of opts.letters) counts[L] = 0;
	for (const { chosen } of latest.values()) counts[chosen] += 1;

	const pct: Record<string, number> = {};
	for (const L of opts.letters) {
		pct[L] = Math.round((counts[L] * 1000) / responders) / 10;
	}
	return { responders, counts, pct, suppressed: false };
}
```

**Step 4:** `pnpm test` → PASS。`pnpm exec tsc --noEmit` 過。

**Step 5:**
```bash
git add worker/lib/choiceStats.ts worker/lib/choiceStats.test.ts
git commit -m "feat(choice-stats): pure tally helper with dedupe + anonymity floor"
```

---

### Task 1.2: 擴充 `GET /:id/stats` 回傳分布

**Files:**
- Modify: `worker/routes/questions.ts:453-472`

**端點決策:擴充既有 `/:id/stats`,不新增 `/:id/choice-stats`。** 理由:(a) 前端在答案揭曉時已經打這支(`frontend/src/components/QuestionCard.tsx:55-63`),擴充等於零新增 request;(b) `responders` 語意與新分布同源,拆兩支會出現兩個不一致的 `responders`;(c) 兩者的 gating 條件相同,合併只需寫一次授權判斷。**代價**:回應變大(多 ~100 bytes),對 20 人規模可忽略。

**Step 1:** handler 開頭先取本題的合法選項與請求者自己的選擇:
```ts
const email = c.var.email;
const q = await c.env.DB.prepare(
	"SELECT options_json FROM questions WHERE id = ?",
).bind(id).first<{ options_json: string }>();
if (!q) return c.json({ error: "no such question" }, 404);
const letters = Object.keys(optionsToRecord(q.options_json)); // 從 ../lib/db import
```

**Step 2:** 兩個來源查詢(exam 只取**已結束**的 session,進行中的作答不得外洩):
```ts
const { results: reviewVotes } = await c.env.DB.prepare(
	`SELECT user_email AS user, last_chosen AS chosen,
	        COALESCE(last_seen_at, 0) AS at
	   FROM review_progress
	  WHERE question_id = ? AND last_chosen IS NOT NULL`,
).bind(id).all<Vote>();

const { results: examVotes } = await c.env.DB.prepare(
	`SELECT s.user_email AS user, ea.chosen AS chosen,
	        COALESCE(ea.answered_at, 0) AS at
	   FROM exam_answers ea
	   JOIN exam_sessions s ON s.id = ea.session_id
	  WHERE ea.question_id = ? AND ea.chosen IS NOT NULL
	    AND s.finished_at IS NOT NULL`,
).bind(id).all<Vote>();
```

**Step 3:** gating + tally。`mine` 為 null 代表請求者尚未作答 → **不回分布**:
```ts
const votes = [...examVotes, ...reviewVotes]; // review 放後面:同 at 時以複習模式的最新選擇為準
const mine = votes.filter((v) => v.user === email).sort((a, b) => a.at - b.at).pop()?.chosen ?? null;

let choices_state: "ok" | "not_answered" | "below_threshold" = "ok";
let tallied = tallyChoices(votes, { letters, minResponders: MIN_RESPONDERS });
if (!mine) {
	choices_state = "not_answered";
} else if (tallied.suppressed) {
	choices_state = "below_threshold";
}
const expose = choices_state === "ok";
return c.json({
	attempts, correct, responders,          // 既有欄位,原樣保留(向後相容)
	accuracy,
	choices: expose ? tallied.counts : null,
	choice_pct: expose ? tallied.pct : null,
	choice_responders: tallied.responders,   // 只是人數,不含分布 → 可安全外露
	choices_state,
	my_choice: mine,
});
```
**注意:** `attempts`/`correct`/`accuracy` 的既有查詢與語意完全不動(它算的是「總作答次數」,分布算的是「人數」——兩個分母不同,文案要分開表述)。

**Step 4:** 本地驗證:
```bash
pnpm dev   # 另開 terminal
curl -s -H 'X-Dev-Email: <admin_email>' localhost:8787/api/questions/114-001/stats | jq
```
Expected:自己沒作答時 `choices: null, choices_state: "not_answered"`;作答後人數不足 5 時 `"below_threshold"`;足夠時 `choices` 有數字且各選項和 = `choice_responders`。
(若 8787 連不上,先確認不是 OpenEvidence MCP relay 佔埠。)

**Step 5:** `pnpm exec tsc --noEmit` → commit:
```bash
git commit -am "feat(stats): expose per-option choice distribution, gated by own answer + anonymity floor"
```

---

### Task 1.3: `exam_answers(question_id)` 索引(migration 0023)

**Files:**
- Create: `migrations/0023_exam_answers_question_idx.sql`

Task 1.2 新增的 exam 查詢是 `WHERE ea.question_id = ?`,但 `exam_answers` 的 PK 是 `(session_id, question_id)`(`migrations/0001_initial_schema.sql:124`),前綴是 `session_id` —— 這個查詢**吃不到索引,會全表掃**。20 人 × 若干場 × 100 題雖然小,但每次揭曉答案都掃一次,加索引是幾乎零成本的正確做法。`review_progress` 那側的 `WHERE question_id = ?` 同樣不吃 PK 前綴,一併補。

**Step 0:** `ls migrations/ | tail -3` 確認最後一號仍是 `0022_highlights.sql`;若不是,把檔名順延。

**Step 1:** 建檔:
```sql
-- 選項分布統計會以 question_id 反查所有作答;兩張表的 PK 前綴都不是
-- question_id,沒有索引會退化成全表掃描。
CREATE INDEX IF NOT EXISTS idx_ea_question ON exam_answers(question_id);
CREATE INDEX IF NOT EXISTS idx_rp_question ON review_progress(question_id);
```

**Step 2:** `pnpm db:migrate:local`,再跑一次 Task 1.2 的 curl 確認沒壞。

**Step 3:**
```bash
git add migrations/0023_exam_answers_question_idx.sql
git commit -m "feat(db): index exam_answers/review_progress by question_id for choice stats"
```
(remote 套用 `pnpm db:migrate:remote` 留到部署時,執行前先問使用者。)

---

### Task 2.1: `QuestionCard` 選項百分比長條

**Files:**
- Modify: `frontend/src/components/QuestionCard.tsx`(型別 `StatsPayload` 在 48-54;選項 map 在 294-350;文字列在 403-407)

**Step 1:** 擴充 `StatsPayload`:
```ts
type StatsPayload = {
	attempts: number; correct: number; responders: number; accuracy: number | null;
	choices: Record<string, number> | null;
	choice_pct: Record<string, number> | null;
	choice_responders: number;
	choices_state: 'ok' | 'not_answered' | 'below_threshold';
	my_choice: string | null;
};
```

**Step 2:** 在 `options.map(({ L, text }) => {` 的 `<li>` 內,把既有內容包一層 relative,長條墊在最底:
```tsx
const pct = stats?.choices_state === 'ok' ? (stats.choice_pct?.[L] ?? 0) : null;
```
```tsx
{pct !== null && (
  <span
    aria-hidden
    className={`absolute inset-y-0 left-0 rounded pointer-events-none ${
      isCorrect ? 'bg-accent/15' : 'bg-ink-200/60 dark:bg-ink-600/40'
    }`}
    style={{ width: `${pct}%` }}
  />
)}
```
`<li>` 的 `cls` 加 `' relative overflow-hidden'`;`<span>` 的文字內容加 `relative`(或 `z-10`)避免被長條蓋住。正解用 accent、其餘用 ink 階 —— 不引入新色。

**Step 3:** 每個選項右側顯示數字(維持既有 `ml-auto` 佈局,和「正解」/「你的選擇」標籤同一列):
```tsx
{pct !== null && (
  <span className="ml-auto shrink-0 text-xs tabular-nums text-ink-500 dark:text-ink-400">
    {pct}%
  </span>
)}
```
「你的選擇」/「正解」標籤沿用現有 emerald / rose 樣式(`frontend/src/components/QuestionCard.tsx:338-348`),**不重做**;長條只是底層資訊。

**Step 4:** 文案。在既有 stats 文字列(403-407)後補一句:
```tsx
{stats?.choices_state === 'ok' && (
  <span className="text-ink-400 dark:text-ink-500">
    · {stats.choice_responders} 人作答的選項分布
  </span>
)}
{stats?.choices_state === 'below_threshold' && (
  <span className="text-ink-400 dark:text-ink-500">
    · 作答人數不足,暫不顯示選項分布
  </span>
)}
```
`not_answered` 不顯示任何字(此時 UI 上使用者根本還沒揭曉)。

**Step 5:** 驗證:
```bash
cd frontend && pnpm build     # 型別 + 建置
```
本地手動:同一題用兩個 `X-Dev-Email` 作答(改 `frontend/vite.config.ts` 的注入值或直接 curl `POST /api/review/answer`)湊滿 5 人 → 重整 → 長條出現、正解那條是 accent、百分比加總 100%。

**Step 6:**
```bash
git commit -am "feat(ui): choice distribution bars on answered question options"
```

---

### Task 2.2: `ExamResult` 檢討頁顯示分布

**Files:**
- Modify: `frontend/src/routes/ExamResult.tsx`(逐題列 94-136)

檢討頁是逐題清單,不適合每題都打一次 `/stats`(100 題 = 100 requests)。做法:**只在使用者展開某題時才取**。

**Step 1:** 每個 `<li>` 加一個「看分布」的展開列(不動既有 `<Link>` 導頁行為 —— 把展開按鈕放在 `<Link>` 之外的同一張卡內,避免點按鈕就跳頁)。

**Step 2:** 展開時 `api.get<StatsPayload>(\`/api/questions/${a.question_id}/stats\`)`,把 `StatsPayload` 型別從 `QuestionCard` 抽到 `frontend/src/lib/api.ts` 或新檔 `frontend/src/lib/choiceStats.ts` 共用(**先抽再用**,不要複製兩份型別)。

**Step 3:** 渲染一個精簡橫條組:每個選項一行 `A ▌▌▌▌ 62%`,你的選擇加 `你` 標記(比對 `a.chosen`)、正解加 `✓`(比對 `a.correct_answer`)。色階與 Task 2.1 一致(正解 `bg-accent/15`,其餘 `bg-ink-200/60 dark:bg-ink-600/40`)。

**Step 4:** 空/未達門檻文案:`choices_state !== 'ok'` 時顯示「作答人數不足,暫不顯示選項分布」。理論上檢討頁的使用者一定已作答,但仍要處理 `not_answered`(未作答題目的 `chosen` 是 NULL,server 會判定沒作答)—— 此時顯示「本題你未作答,作答後才會顯示分布」。

**Step 5:** `cd frontend && pnpm build` 過;本地開一場考完的 session 檢討頁,展開幾題確認數字與 `QuestionCard` 一致。

**Step 6:**
```bash
git commit -am "feat(ui): expandable choice distribution in exam review list"
```

---

## 驗收清單

- [ ] `pnpm test` 全綠(含新的 `choiceStats.test.ts` 六個分支:去重、NULL、非法值、門檻、零票、同時戳)
- [ ] `pnpm exec tsc --noEmit` 過;`cd frontend && pnpm build` 過
- [ ] 未作答者 `curl /api/questions/<id>/stats` 回 `choices: null` 且 `choices_state: "not_answered"` —— **回應裡不得出現任何 per-option 數字**
- [ ] 作答人數 < 5 時 `choices_state: "below_threshold"`,`choices` 仍為 null
- [ ] 分布各選項加總 = `choice_responders`;百分比加總在 99.9–100.1 之間(四捨五入容差)
- [ ] 同一使用者既有 review 又有 exam 紀錄時只算一票(可用 D1 手動塞資料驗)
- [ ] 既有 `attempts`/`correct`/`accuracy` 欄位與舊行為完全一致(舊前端不會壞)
- [ ] `QuestionCard` 長條:正解 accent、其餘 ink;無漸層、無陰影堆疊;深色模式可讀
- [ ] `ExamResult` 展開分布,數字與 `QuestionCard` 一致

## 風險與回滾

| 風險 | 對策 |
|---|---|
| **反推個資**(20 人小群體) | `MIN_RESPONDERS = 5` 硬門檻 + 只回聚合數字,不回 user 清單。若組員反映仍不安,把常數調高到 8,單點修改。 |
| **洩漏答案傾向** | server 端以 `my_choice` 是否存在 gating,前端無法繞過;`choice_responders` 只是人數,無方向性。 |
| **exam 進行中的作答外洩** | 查詢限定 `s.finished_at IS NOT NULL`。 |
| 清除作答紀錄(`worker/routes/review.ts:298`)會使該人票消失 | 預期行為(撤票),不特別處理;但 exam 那票仍在,分布不會歸零。 |
| 前端 payload 形狀改變 | 只**新增**欄位,舊欄位不動,舊 build 照常運作。 |
| 回滾 | Task 2.x 前端可單獨 `git revert`;Task 1.2 revert 即回到原 `/stats`;索引 migration 留著無害(不需 down migration)。 |

## 成本

- **D1 讀取**:每次揭曉答案多 2 個 indexed SELECT(Task 1.3 之後),1000 題 × 20 人的資料量下每次掃描列數以十計。免費額度 5M reads/day,遠遠用不到。
- **Workers**:純運算,無 AI、無 KV、無新 binding。
- **快取**:**先不做**。資料會隨每次作答變動,而查詢本身是 sub-millisecond;加 KV/Cache API 只會引入 staleness 與額外複雜度。若日後題庫或人數放大一個量級,再考慮 `Cache-Control: private, max-age=60` 於 `/stats` 回應(單行改動)。
- 淨增:0 元,仍在 Cloudflare free tier。

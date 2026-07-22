# 冪等性審計與設計 — Worker 寫入路徑

*2026-07-21*

## 為什麼寫這份

問題：「我們有很多 worker，冪等性都照顧到了嗎？」

答案：**沒有統一機制。** 全站沒有任何 `Idempotency-Key` / request-id 中介層。
每個「安全」的端點都是靠**結構**各自達成冪等（UPSERT / `ON CONFLICT` /
delete-by-key / 設值 / version guard / unique index），沒有一個靠請求去重。
因此所有 **append 路徑**（`attempts`、`comments`、`confidence_events`、
`fsrs_review_logs`、chat `messages`、feedback GitHub issue）與 **increment
路徑**（`review_progress` 計數、`mcq_key_version`）在 client 或中間層重送
一次 POST 時就會重複寫入 / 重複產生副作用。

唯一一次考慮過冪等的紀錄，是 `docs/plans/2026-07-20-pwa-offline.md` 的
Milestone 5（離線佇列 `client_id`），但被標成「可選」且**從未實作** ——
沒有 migration，worker 裡沒有任何 `client_id`。

## 全端點盤點

`*` = 靠比較 / guard 達成，防單純重送、不防真正並發的重複投遞。

| 端點 | 位置 | 寫入 | 重送冪等？ | 機制 |
|---|---|---|---|---|
| POST `/exam/start` | exam.ts:40 | 新 session + N answers | **否** | server uuid，無去重 |
| POST `/exam/custom` | exam.ts:141 | 新 session + N answers | **否** | server uuid，無去重 |
| POST `/exam/:sid/answer` | exam.ts:345 | UPDATE answer **+ append attempts** | **否** | 每次 append |
| POST `/exam/:sid/finish` | exam.ts:439 | UPDATE session/answers/attempts | 是 | `if(finished_at)→400` guard |
| PUT `/exam/:sid/flag` | exam.ts:406 | UPDATE flag | 是 | 設 0/1 |
| POST `/exam/:sid/pause`/`resume` | exam.ts:283,313 | UPDATE elapsed/running | 是* | guard |
| DELETE `/exam/:sid` | exam.ts:600 | DELETE | 是 | delete-by-id |
| POST `/review/answer` | review.ts:149 | **increment** review_progress + append attempts + append confidence | **否** | 計數重複 |
| POST `/review/anki/review` | review.ts:678 | UPSERT fsrs_cards（**re-advance**）+ append fsrs_review_logs + append attempts | **否** | 重推排程 |
| DELETE `/review/answer/:id` | review.ts:323 | DELETE | 是 | delete-by-key |
| PUT `/review/goal` | review.ts:916 | UPSERT | 是 | 設值 |
| POST `/comments/:id/comments` | comments.ts:42 | INSERT comment + mentions + notifications | **否** | server uuid，無去重 |
| PATCH/DELETE comment | comments.ts:140,177 | UPDATE / soft-delete | 是 | 設值 |
| POST `/comments/:cid/helpful` | helpful.ts:15 | INSERT vote | 是 | `ON CONFLICT DO NOTHING` |
| PUT/DELETE bookmark | bookmarks.ts | UPSERT / DELETE | 是 | `ON CONFLICT DO UPDATE` |
| PUT/DELETE highlight | highlights.ts | UPSERT / DELETE | 是 | LWW upsert |
| POST `/feedback` | feedback.ts:13 | **GitHub issue（外部副作用）** | **否** | 無 key |
| POST `/upload`、`/upload/url` | upload.ts:10,40 | R2 put | 部分 | 每次新 key → 孤兒 blob |
| POST `/questions/:id/challenges` | challenges.ts:33 | INSERT challenge | 是* | partial UNIQUE + catch |
| POST/DELETE `/challenges/:cid/votes` | challenges.ts:55,72 | UPSERT / DELETE | 是 | `ON CONFLICT DO UPDATE` |
| PATCH rationale / withdraw / recompute | challenges.ts | UPDATE | 是 | status-guarded |
| PUT `/questions/:id/answer` | questions.ts:201 | UPDATE + append history | 是* | `if(answer===next)` no-op guard |
| POST/DELETE `/questions/:id/tags` | questions.ts:420,440 | INSERT / DELETE | 是 | `ON CONFLICT DO NOTHING` |
| PUT `/explanations/:id/explanation` | explanations.ts:36 | UPDATE + append history | 是 | version 樂觀鎖 → 409 |
| lock / unlock explanation | explanations.ts:16,30 | 設 lock 欄位 | 是 | 設值 |
| PUT/DELETE note | notes.ts:10,35 / mcq.ts:142 | UPSERT / DELETE | 是 | `ON CONFLICT DO UPDATE` |
| POST `/folders` | folders.ts:45 | INSERT folder | **否** | server uuid |
| PATCH/DELETE folder | folders.ts:69,95 | UPDATE / DELETE | 是 | 設值 / delete-by-key |
| POST `/lectures/:slug/annotations` | lectures.ts:153 | INSERT | **否** | server uuid |
| POST `/lectures/:slug/notes` | lectures.ts:250 | INSERT | **否** | server uuid |
| PUT `/lectures/:slug/notes/by-page/:page` | lectures.ts:282 | read-then-write upsert | 是* | app 層 upsert（無 unique，並發有 race） |
| PATCH/DELETE lecture note/annotation | lectures.ts | UPDATE / DELETE | 是 | 設值 |
| PATCH `/me` | me.ts:19 | UPDATE users | 是 | 設值 |
| POST `/me/mcq-key/rotate` | me.ts:95 | **`version = version + 1`** | **否** | increment |
| POST `/me/avatar` | me.ts:153 | R2 put + UPDATE avatar_key | 部分 | 新 key；UPDATE 本身是設值 |
| PATCH notifications read / read-all | notifications.ts:37,49 | UPDATE WHERE read_at IS NULL | 是 | 設值 |
| PUT/DELETE `/state/...` | state.ts | DO set / clear | 是 | 設值 |
| POST `/search`（記錄歷史） | search.ts:119 | UPSERT search_history | 是 | `ON CONFLICT DO UPDATE` |
| Chat DO `send` / `react` | chat-room.ts:147,201 | INSERT message / toggle reaction | **否** | 見下 |

### 需要修的（Tier 1，D1 端點）

`feedback`、`review/answer`、`review/anki/review`、`comments POST`、
`exam/start`、`exam/custom`、`exam/:sid/answer`、`folders POST`、
`lectures notes/annotations POST`、`me/mcq-key/rotate`。

### Tier 2（Chat Durable Object）

`chat-room.ts` 的 `messages` 表在 DO 自己的 SQLite，不走 D1，需獨立的
client message-id 去重（見下）。低嚴重度（重複聊天列、會被裁到 500 則），
但納入本次一併處理。

### 不在本次範圍（已記錄）

- **`/upload`、`/me/avatar`**：重送只產生孤兒 R2 blob，不污染資料，低嚴重度。
- 已天生冪等的 toggle / set / delete-by-key 端點：無需改動。

## 設計：`Idempotency-Key` + `request_dedup`

**核心原則：向後相容。** 沒帶 key 時，行為與現況**完全一致**（線上路徑零改變）。
帶了 key，重送就 replay 既有結果、跳過所有 append / increment / 外部副作用。

### 傳輸

HTTP header `Idempotency-Key`（標準命名，且對 multipart 的 upload 也適用）。
前端每個「一次使用者動作」產生一個穩定 UUID，**重送時沿用同一個**
（用 `useRef`／component-scoped ref，不可每次 render 重新產生）。

### Migration `0031_request_dedup.sql`

```sql
CREATE TABLE request_dedup (
  client_id     TEXT PRIMARY KEY,
  user_email    TEXT NOT NULL,
  endpoint      TEXT NOT NULL,       -- 例如 'POST /review/answer'
  status        INTEGER NOT NULL,    -- replay 時要還原的 HTTP 狀態碼
  response_json TEXT NOT NULL,       -- replay 時要還原的 body
  created_at    INTEGER NOT NULL
);
CREATE INDEX idx_request_dedup_created ON request_dedup(created_at);
```

`client_id` 帶入的是使用者提供的 key，用 `user_email` 前綴命名空間化以防
跨使用者碰撞：實際存的 PK 值是 `${email}:${key}`（helper 內組裝，呼叫端只給 raw key）。

### Helper `worker/lib/idempotency.ts`

```
IDEMPOTENCY_HEADER = 'Idempotency-Key'
readIdemKey(c): string | null          // 讀 header，驗證非空且 ≤128 字元，否則 null
idemLookup(db, email, key): Promise<{ status:number; body:unknown } | null>
idemRecordOp(db, { email, key, endpoint, status, body, now }): D1PreparedStatement
                                        // INSERT OR IGNORE，回傳 statement 供併進 batch()
```

### 每個 D1 端點的整合樣式

```ts
const key = readIdemKey(c);
if (key) {
  const hit = await idemLookup(c.env.DB, email, key);
  if (hit) return c.json(hit.body, hit.status);   // replay，完全跳過寫入
}
// ... 照原本邏輯算出 payload 與 status ...
const ops = [ ...原本的寫入 statements ];
if (key) ops.push(idemRecordOp(c.env.DB, {
  email, key, endpoint: 'POST /review/answer', status, body: payload, now,
}));
await c.env.DB.batch(ops);              // 去重列與寫入同一交易，不會分岔
return c.json(payload, status);
```

把去重列的 INSERT **併進既有的 `DB.batch()`**（`exam/start`、`review/answer`、
`exam/:sid/answer` 本來就有 batch；`comments`、`folders`、`lectures`、
`me/mcq-key/rotate` 目前是分開的 `.run()`，需改成 batch 才能保證原子性）。

### feedback（外部副作用，無 D1 batch）

```ts
const key = readIdemKey(c);
if (key) { const hit = await idemLookup(...); if (hit) return c.json(hit.body, hit.status); }
// 呼叫 GitHub API...
const payload = { ok:true, url, number };
if (key) await idemRecordOp(c.env.DB, {..., status:200, body:payload, now}).run();
return c.json(payload, 200);
```

### Chat DO（Tier 2）

`handleSend` 收 `{ type:'send', cid, text, ... }`，`cid` 是 client 產生的訊息 id。
DO 的 `messages` 表加 `client_id TEXT` 欄位（用 `CREATE TABLE IF NOT EXISTS`
既有邏輯 + 一次性 `ALTER TABLE ... ADD COLUMN` 守衛）與 UNIQUE index，
`INSERT OR IGNORE`；`changes === 0`（重送）就**不廣播**、直接回既有訊息。
`react` 是 toggle，維持現狀（重送翻回去是可接受的既有行為，且有 PK 保護）。

### 過期清理

`request_dedup` 會累積。在 `worker/index.ts` 的 `scheduled()` cron 加一段
`DELETE FROM request_dedup WHERE created_at < now - 7d`。7 天遠大於任何合理的
重試窗口。獨立 try/catch，不拖累 roster sync。

## 前端接線

1. `frontend/src/lib/api.ts`：`request()` 與 `api.post/put/upload` 接受選填
   `idempotencyKey`，有給就設 `Idempotency-Key` header。
2. 各呼叫端用 `useRef` 產生「每次動作一個」的穩定 key，送出時沿用；
   成功後重置 ref 供下一次動作。優先接：feedback 送出、留言送出、
   `review/answer`、`exam/start`、`me/mcq-key/rotate`。
3. 這些動作多半已在送出時 disable 按鈕（防雙擊）；idempotency key 是
   額外保險，並涵蓋網路層重試。

## 威脅模型與限制（誠實記錄）

- **主要防護對象：循序重送**（網路 timeout 後 client / 中間層重試同一個
  POST）。這是 20 人內部工具的真實威脅，此設計完整涵蓋。
- **同一 key 的真正並發雙發**（第一個還沒 commit，第二個已進來）：兩者都
  可能通過前置 lookup。D1 batch 內的 `INSERT OR IGNORE` 只保證去重列不重複，
  不阻止第二筆的寫入。最壞情況等同今日（一筆重複），**無退步**。實務上
  key 是 per-action 產生、只有網路重試才會重用，並發同 key 幾乎不會發生。
- feedback：GitHub 成功但去重列寫入失敗的窗口，下次重試會再開一張。可接受。

## 驗收

- `node --test worker/**/*.test.ts` 全綠（含新增 `idempotency.test.ts`）。
- `pnpm exec tsc --noEmit`（worker）與 `cd frontend && pnpm exec tsc --noEmit` 通過。
- 本地手測：同一 `Idempotency-Key` 對 `/review/answer` 送兩次，`times_seen`
  只 +1、`attempts` 只多一列、第二次回傳與第一次相同 body。
- `cd frontend && pnpm build` 通過。

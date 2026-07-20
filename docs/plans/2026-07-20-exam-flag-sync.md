# 考試標記跨裝置同步 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 把模擬考的「標記待回頭檢查」從純瀏覽器端狀態升級成 server-backed、跨裝置一致的資料,並讓結果頁能「只看我標記的題」做檢討。

**Architecture:** 標記天然屬於 `(session_id, question_id)`,直接在既有 `exam_answers` 加欄位,不開新表。寫入沿用 highlights 的「本機即時 + 背景送出 + 讀取時對帳」模式(`frontend/src/lib/highlightStore.ts:61`),對帳邏輯抽成純函式測試。API 走既有 exam 路由,一律以 `c.var.email` 驗證 session 擁有者。

**Tech Stack:** Cloudflare Workers (Hono) + D1;前端 React 18 + Vite + TypeScript。測試 `node:test` + `node:assert/strict`(worker 走 `pnpm test`;前端純函式檔同目錄 `*.test.ts`,以 `node --test --experimental-strip-types` 執行,比照 `frontend/src/lib/highlightSync.test.ts:1`)。無新增 Cloudflare 服務。

---

## 現況(file:line 佐證)

- **標記存在 sessionStorage,不是 localStorage。** `frontend/src/routes/Exam.tsx:206-213` 以 `sessionStorage.getItem('exam-marks-' + sessionId)` 初始化 `marked: Set<string>`;`Exam.tsx:216-228` 的 `toggleMark()` 每次寫回同一把 key;`Exam.tsx:363` 交卷後 `removeItem`。原始碼註解(`Exam.tsx:203-205`)明說「local-only … Not synced to the server」。
  - **後果比預期更嚴重**:sessionStorage 是「每分頁 × 每次瀏覽 session」,不只換裝置會消失,**關掉分頁再開同一場考試就已全部不見**。
- 標記目前只影響三處 UI:題卡上的標記鈕 `Exam.tsx:463-476`、導覽列計數 `Exam.tsx:527-531`、格子旗標 `Exam.tsx:534-565`。
- **`exam_answers` 在 `/start` 就為「每一題」預先建列**:`worker/routes/exam.ts:80-88` 迴圈 `INSERT INTO exam_answers (session_id, question_id)`,`chosen` 留 NULL。→ **未作答題本來就有列**,加欄位即可標記,不需 upsert 新列。
- Schema:`migrations/0001_initial_schema.sql:118-125`,PK `(session_id, question_id)`,`ON DELETE CASCADE` 掛在 `exam_sessions`(`0001:104-113`);後續 `0007_exam_pause.sql`、`0010_exam_cap_ms.sql` 皆以 `ALTER TABLE ... ADD COLUMN` 擴充,本計畫沿用。
- API:`/start` `exam.ts:37`、`GET /:sid/state` `exam.ts:108`(SELECT 只取 `ea.chosen`,`exam.ts:121-130`)、`POST /:sid/answer` `exam.ts:215`(擁有者檢查 `exam.ts:228-230`)、`/pause` `exam.ts:153`、`/resume` `exam.ts:183`、`/finish` `exam.ts:245`(計分 `exam.ts:263-273`)、結果 `GET /:sid` `exam.ts:304-330`。
- 結果頁篩選只有 `'all' | 'wrong' | 'right'`:`frontend/src/routes/ExamResult.tsx:28`、`:43-47`、頁籤 `:75-91`。**目前無法只看標記題。**
- 可借用的同步範式:`worker/routes/highlights.ts:41-69`(PUT upsert + `updated_at` LWW)、`highlightStore.ts:61-65`(先寫本機再 fire-and-forget)、`highlightStore.ts:80-99`(reconcile)、`highlightStore.ts:106-137`(`migrateLocalHighlights()`,`anno:synced:v1` 旗標)、純函式 `frontend/src/lib/highlightSync.ts:14-27`、掛載點 `frontend/src/App.tsx:84-87`。
- migrations 目前最後一號是 `0022_highlights.sql`,故本計畫用 **0023**(需求書寫的 0025 是估計值;實作前再 `ls migrations/` 確認,若被佔用就順延)。

## 非目標

- 不做即時推播(無 WebSocket/polling);對帳只在進入 session 或載入結果頁時發生。
- 不改計分:`flagged` 完全不參與 `exam.ts:263-273`。
- 不擴散到複習模式(`review_progress.bookmarked` 是另一套機制)。
- 不做標記備註文字或顏色分級。

## 跨切面約定

- migration **只新增不改**。所有 session 操作先查擁有者比對 `c.var.email`,不符回 403(比照 `exam.ts:229`)。
- 純函式優先抽出、先寫失敗測試;測試檔與原始碼同目錄。
- UI 沿用 scholarly/editorial:標記色維持現有 amber 系(`Exam.tsx:466-469`),accent 只用 `accent` / `accent-dark` / `accent-light`。
- 每個 Task 各自可獨立 commit。

---

### Task 1.1: migration — `exam_answers` 加 `flagged` / `flagged_at`

**Files:** Create `migrations/0023_exam_answer_flag.sql`

**取捨(寫進註解):** 另開 `exam_flags` 表也可行,但 (a) PK 完全等同 `exam_answers` 的 `(session_id, question_id)`;(b) `/start` 已為每題建列(`exam.ts:80-88`),含未作答題;(c) 刪 session 要靠同一條 CASCADE。新表只多一次 JOIN 與一份重複外鍵。`flagged_at` 是對帳用的 LWW 時間戳,沒有它就無法解「兩邊都改過」。

**Step 1:**
```sql
-- ============================================================
-- Migration 0023: 考試標記(mark for review)跨裝置同步
--
-- 「標記待回頭檢查」原本只存在瀏覽器 sessionStorage
-- (frontend/src/routes/Exam.tsx),換裝置、關分頁即消失。
-- 標記的自然鍵就是 (session_id, question_id) —— 與 exam_answers
-- 的 PK 相同,且 /start 已為每一題(含未作答)預先建列,
-- 因此直接加欄位,不另開表。flagged 不參與計分。
--   flagged    0/1,預設 0
--   flagged_at 最後一次變更的 ms timestamp,供本機/server 對帳
-- ============================================================

ALTER TABLE exam_answers ADD COLUMN flagged INTEGER NOT NULL DEFAULT 0;
ALTER TABLE exam_answers ADD COLUMN flagged_at INTEGER;
```

**Step 2:** 套用並驗證:
```bash
pnpm db:migrate:local
wrangler d1 execute $(node scripts/lib/cfg.mjs project.d1_db) --local \
  --command "SELECT name FROM pragma_table_info('exam_answers') WHERE name IN ('flagged','flagged_at')"
```
Expected: 兩列。

**Step 3:** `git commit -m "feat(exam): exam_answers.flagged column for cross-device mark-for-review"`

---

### Task 1.2: API — `PUT /api/exam/:sid/flag` + state/result 帶上 flags

**Files:** Modify `worker/routes/exam.ts`

**設計決定(寫成註解):**
- **獨立端點,不併入 `/answer`。** `/answer` 有 400ms debounce 與交卷前的全量重送(`Exam.tsx:310-317`、`:355-360`),把標記塞進去會讓「只改標記」也重寫 `chosen/answered_at`。
- **已結束的 session 明確「允許」改標記**(與 `/answer` 的 `exam.ts:230` 回 400 不同):檢討階段仍要能加/去標記做二輪複習,且 `flagged` 不參與計分,無事後改分風險。
- **冪等**:重送同值只是把同樣的 0/1 再寫一次,回傳相同 body。

**Step 1:** 在 `/answer` handler 之後新增:
```ts
// 標記/取消標記一題。與 /answer 分離:標記可在交卷後於檢討階段繼續調整,
// 且不參與計分。冪等 —— 重送同值結果相同。
examRoutes.put('/:sid/flag', async (c) => {
  const sid = c.req.param('sid');
  const email = c.var.email;
  const body = await c.req.json<{ question_id?: string; flagged?: boolean; at?: number }>();
  if (!body.question_id || typeof body.flagged !== 'boolean') {
    return c.json({ error: 'question_id and flagged required' }, 400);
  }
  const session = await c.env.DB
    .prepare('SELECT user_email FROM exam_sessions WHERE id = ?')
    .bind(sid).first<{ user_email: string }>();
  if (!session) return c.json({ error: 'session not found' }, 404);
  if (session.user_email !== email) return c.json({ error: 'forbidden' }, 403);

  const at = typeof body.at === 'number' ? body.at : Date.now();
  // UPDATE(非 upsert):/start 已為每題建列,用 UPDATE 順便擋掉不屬於
  // 這場考試的 question_id,避免被塞進假列。
  const res = await c.env.DB
    .prepare(`UPDATE exam_answers SET flagged = ?, flagged_at = ?
              WHERE session_id = ? AND question_id = ?`)
    .bind(body.flagged ? 1 : 0, at, sid, body.question_id).run();
  if (!res.meta.changes) return c.json({ error: 'question not in session' }, 404);
  return c.json({ ok: true, flagged: body.flagged, flagged_at: at });
});
```

**Step 2:** `/:sid/state` 的 SELECT(`exam.ts:121-130`)加 `ea.flagged, ea.flagged_at`,列型別補 `flagged: number; flagged_at: number | null`,回傳物件(`exam.ts:142-148`)加 `flagged: r.flagged === 1, flagged_at: r.flagged_at`。

**Step 3:** `GET /:sid` 的 SELECT(`exam.ts:316-327`)同樣加 `ea.flagged, ea.flagged_at`,結果頁才拿得到。

**Step 4:** 驗證(`pnpm exec tsc --noEmit` 後,另一終端 `pnpm dev`;若 8787 不通先確認不是 OpenEvidence relay 佔埠):
```bash
H='-H content-type:application/json -H X-Dev-Email:<admin>'
curl -s -X PUT localhost:8787/api/exam/$SID/flag $H -d '{"question_id":"114-003","flagged":true}'
curl -s -X PUT localhost:8787/api/exam/$SID/flag $H -d '{"question_id":"114-003","flagged":true}'  # 冪等
curl -s localhost:8787/api/exam/$SID/state -H X-Dev-Email:<admin> | grep -o '"flagged":true' | head -1
curl -s -X PUT localhost:8787/api/exam/$SID/flag -H content-type:application/json \
  -H X-Dev-Email:other@example.com -d '{"question_id":"114-003","flagged":false}'   # 期望 403
```

**Step 5:** `git commit -m "feat(exam): PUT /:sid/flag + expose flags in state/result"`

---

### Task 1.3: 對帳純函式 `mergeFlags`(TDD)

**Files:** Create `frontend/src/lib/examFlagSync.ts` / Test `frontend/src/lib/examFlagSync.test.ts`

角色同 `highlightSync.ts:14` 的 `pickHighlight`:只做決策,不碰 DOM/網路。差別在標記是一整組 per-question 狀態,逐 qid 取較新者並回報要補推的 qid。

**Step 1 — 失敗測試:**
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeFlags } from "./examFlagSync.ts";

test("本機有、server 沒有 → 採本機並列入上推", () => {
  const out = mergeFlags({ a: { flagged: true, t: 10 } }, []);
  assert.equal(out.flags.a.flagged, true);
  assert.deepEqual(out.push, ["a"]);
});

test("server 有、本機沒有 → 採 server,不上推", () => {
  const out = mergeFlags({}, [{ question_id: "b", flagged: true, flagged_at: 10 }]);
  assert.equal(out.flags.b.flagged, true);
  assert.deepEqual(out.push, []);
});

test("兩邊衝突取較新(server 較新 / 本機較新)", () => {
  const a = mergeFlags({ c: { flagged: false, t: 5 } }, [{ question_id: "c", flagged: true, flagged_at: 9 }]);
  assert.equal(a.flags.c.flagged, true);
  assert.deepEqual(a.push, []);
  const b = mergeFlags({ c: { flagged: true, t: 20 } }, [{ question_id: "c", flagged: false, flagged_at: 9 }]);
  assert.equal(b.flags.c.flagged, true);
  assert.deepEqual(b.push, ["c"]);
});

test("時間戳相同 → 以 server 為準且不上推(避免無限互推)", () => {
  const out = mergeFlags({ d: { flagged: true, t: 7 } }, [{ question_id: "d", flagged: false, flagged_at: 7 }]);
  assert.equal(out.flags.d.flagged, false);
  assert.deepEqual(out.push, []);
});

test("舊本機資料缺 t → 視為 0,server 任何值都較新", () => {
  const out = mergeFlags({ e: { flagged: true } }, [{ question_id: "e", flagged: false, flagged_at: 1 }]);
  assert.equal(out.flags.e.flagged, false);
});

test("本機獨有但為 false → 不上推(預設值沒有資訊量)", () => {
  assert.deepEqual(mergeFlags({ f: { flagged: false, t: 3 } }, []).push, []);
});
```

**Step 2:** `node --test --experimental-strip-types frontend/src/lib/examFlagSync.test.ts` → FAIL(找不到模組)。

**Step 3 — 實作:**
```ts
// 考試標記的本機/server 對帳。逐題 last-write-wins:本機較新就回報要上推,
// server 較新(或同時間)就採 server。純函式,無 DOM/網路。
export type LocalFlag = { flagged: boolean; t?: number };
export type LocalFlags = Record<string, LocalFlag>;
export type ServerFlag = { question_id: string; flagged: boolean; flagged_at: number | null };
export type MergedFlags = {
  flags: Record<string, { flagged: boolean; t: number }>;
  push: string[]; // 本機較新、需要 PUT 上去的 question_id
};

export function mergeFlags(local: LocalFlags, server: ServerFlag[]): MergedFlags {
  const flags: MergedFlags["flags"] = {};
  const push: string[] = [];
  for (const s of server) flags[s.question_id] = { flagged: s.flagged, t: s.flagged_at ?? 0 };
  for (const [qid, l] of Object.entries(local)) {
    const lt = l.t ?? 0;
    const cur = flags[qid];
    if (!cur) {
      flags[qid] = { flagged: l.flagged, t: lt };
      if (l.flagged) push.push(qid); // 本機的「未標記」是預設值,推上去只是白花一次寫入
    } else if (lt > cur.t) {
      flags[qid] = { flagged: l.flagged, t: lt };
      push.push(qid);
    }
  }
  push.sort();
  return { flags, push };
}
```

**Step 4:** 重跑測試 → PASS。

**Step 5:** `git commit -m "feat(exam): pure mergeFlags reconciler for exam marks"`

---

### Task 1.4: 前端 store — 本機即時 + 背景送出

**Files:** Create `frontend/src/lib/examFlagStore.ts`

比照 `highlightStore.ts:61-65`:先落本機再 fire-and-forget 打 API,失敗吞掉,**畫面上的標記絕不因網路失敗而消失**。本機層改用 `localStorage`(sessionStorage 連關分頁都撐不過),key `exam:flags:<sid>`。

**Step 1:**
```ts
import { api } from './api';
import { mergeFlags, type LocalFlags, type ServerFlag } from './examFlagSync';

const key = (sid: string) => `exam:flags:${sid}`;

export function readLocalFlags(sid: string): LocalFlags {
  try { const raw = localStorage.getItem(key(sid)); return raw ? JSON.parse(raw) as LocalFlags : {}; }
  catch { return {}; }
}
export function writeLocalFlags(sid: string, flags: LocalFlags): void {
  try { localStorage.setItem(key(sid), JSON.stringify(flags)); } catch { /* quota */ }
}
export function flaggedIds(sid: string): string[] {
  return Object.entries(readLocalFlags(sid)).filter(([, v]) => v.flagged).map(([k]) => k);
}
// /state 或 /:sid 的題目陣列 → ServerFlag[]
export function toServerFlags(rows: Array<{ id?: string; question_id?: string; flagged?: boolean | number; flagged_at?: number | null }>): ServerFlag[] {
  return rows.map((r) => ({
    question_id: (r.question_id ?? r.id)!,
    flagged: r.flagged === true || r.flagged === 1,
    flagged_at: r.flagged_at ?? null,
  }));
}

// 使用者 toggle:本機立即生效,server 背景補;離線時本機仍保留,
// 下次進入該 session 由 reconcileFlags 上推。
export function setFlag(sid: string, qid: string, flagged: boolean): void {
  const t = Date.now();
  writeLocalFlags(sid, { ...readLocalFlags(sid), [qid]: { flagged, t } });
  void api.put(`/api/exam/${sid}/flag`, { question_id: qid, flagged, at: t }).catch(() => {});
}

// 進入 session 時對帳。serverRows 來自已取得的 /state 或 /:sid 回應,不多打 API。
export async function reconcileFlags(sid: string, serverRows: ServerFlag[]) {
  const merged = mergeFlags(readLocalFlags(sid), serverRows);
  writeLocalFlags(sid, merged.flags);
  for (const qid of merged.push) {
    const v = merged.flags[qid];
    try { await api.put(`/api/exam/${sid}/flag`, { question_id: qid, flagged: v.flagged, at: v.t }); }
    catch { /* 下次進來再推 */ }
  }
  return merged.flags;
}
```

**Step 2:** `cd frontend && pnpm typecheck` 過。

**Step 3:** `git commit -m "feat(exam): localStorage-first flag store with background sync"`

---

### Task 1.5: 舊 sessionStorage 標記的一次性遷移

**Files:** Modify `frontend/src/lib/examFlagStore.ts`、`frontend/src/App.tsx`

**誠實的範圍說明(寫進註解):** 舊資料在 **sessionStorage**(`Exam.tsx:206-213`),生命週期只到分頁關閉,所以這支只救得到「升級當下還開著同一分頁」的使用者。它便宜,但別當成主要修復;真正的修復是 Task 1.4 的寫入路徑。旗標比照 `anno:synced:v1`(`highlightStore.ts:106`)。

**Step 1:**
```ts
const MIGRATED_FLAG = 'exam:flags:synced:v1';

// 一次性:把舊版 sessionStorage 的 `exam-marks-<sid>`(string[])推上 server。
// 先併入本機再走 reconcileFlags(server 現況參與比較),因此不會覆蓋較新的 server 值。
export async function migrateLocalExamFlags(): Promise<void> {
  try { if (localStorage.getItem(MIGRATED_FLAG)) return; } catch { return; }
  const found: Array<{ sid: string; qids: string[] }> = [];
  try {
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i);
      if (!k?.startsWith('exam-marks-')) continue;
      const qids = JSON.parse(sessionStorage.getItem(k) || '[]') as string[];
      if (Array.isArray(qids) && qids.length) found.push({ sid: k.slice('exam-marks-'.length), qids });
    }
  } catch { return; }

  for (const { sid, qids } of found) {
    const local = readLocalFlags(sid);
    // 舊標記沒有時間戳:給最小非零值,任何 server 端寫入都比它新
    for (const qid of qids) if (!local[qid]) local[qid] = { flagged: true, t: 1 };
    writeLocalFlags(sid, local);
    try {
      const s = await api.get<{ questions: any[] }>(`/api/exam/${sid}/state`);
      await reconcileFlags(sid, toServerFlags(s.questions));
    } catch { /* session 已結束或不存在 —— 跳過 */ }
  }
  try { localStorage.setItem(MIGRATED_FLAG, String(found.length)); } catch { /* ignore */ }
}
```

**Step 2:** `App.tsx:84-87` 的 effect 改為同時呼叫 `void migrateLocalHighlights(); void migrateLocalExamFlags();`。

**Step 3:** 手動驗證:`sessionStorage.setItem('exam-marks-<sid>', '["114-003"]')` → 重新載入 →
```bash
wrangler d1 execute $(node scripts/lib/cfg.mjs project.d1_db) --local \
  --command "SELECT question_id, flagged FROM exam_answers WHERE session_id='<sid>' AND flagged=1"
```

**Step 4:** `git commit -m "feat(exam): one-time migration of sessionStorage marks to server"`

---

### Task 1.6: Exam.tsx 改接 server 標記

**Files:** Modify `frontend/src/routes/Exam.tsx`

**Step 1:** `ExamQuestion`(`Exam.tsx:11-17`)加 `flagged?: boolean; flagged_at?: number | null`。

**Step 2:** 移除 sessionStorage 初始化(`Exam.tsx:206-213`),改 `useState(() => new Set(flaggedIds(sessionId)))`,維持首屏即時。

**Step 3:** `toggleMark`(`Exam.tsx:216-228`)算出 `next` 後改呼叫 `setFlag(sessionId, qid, next.has(qid))`。**不得**在 API 失敗時回滾 UI(store 已吞例外)。

**Step 4:** 載入 effect(`Exam.tsx:231-252`)在 `/state` 的 `.then()` 內呼叫 `reconcileFlags(sessionId, toServerFlags(s.questions))`,以回傳結果 `setMarked(new Set(...))` —— **重新進入 session 以 server 為準**;失敗不影響作答流程。

**Step 5:** 交卷處(`Exam.tsx:362-363`)拿掉 `sessionStorage.removeItem('exam-marks-...')`(標記要留給結果頁),保留 `exam-<sid>` 那行。

**Step 6:** 導覽列(`Exam.tsx:527-531`、`:534-565`)樣式不動,資料來源已一致。

**Step 7:** 驗證 `cd frontend && pnpm typecheck && pnpm build`;本地開一場考試 → 標記 3 題 → **關分頁重開**,標記還在;另一瀏覽器 profile 用同帳號進同一 session,標記一致。

**Step 8:** `git commit -m "feat(exam): server-synced mark-for-review in exam runner"`

---

### Task 1.7: 結果頁「只看標記」篩選

**Files:** Modify `frontend/src/routes/ExamResult.tsx`

**Step 1:** `Result['answers']`(`ExamResult.tsx:15-22`)加 `flagged: 0 | 1; flagged_at: number | null`(Task 1.2 已回傳)。

**Step 2:** filter 型別(`:28`)擴為 `'all' | 'wrong' | 'right' | 'flagged'`;`visible`(`:43-47`)加 `if (filter === 'flagged') return a.flagged === 1;`。

**Step 3:** 頁籤陣列(`:76`)加 `'flagged'`,標籤 `標記 (${flaggedCount})`,沿用同一組 class(`:80-84`),不新增顏色;數量為 0 時頁籤 `disabled`,避免點進空清單。

**Step 4:** 清單項目(`:95-135`)在題號圓標旁,`a.flagged === 1` 時加 `<Flag size={11} className="fill-amber-500 text-amber-600" />`,與考試中視覺一致(`Exam.tsx:554-561`)。

**Step 5:** 驗證:交卷後進結果頁,「標記」頁籤只看到標記過的題;`cd frontend && pnpm build` 過。

**Step 6:** `git commit -m "feat(exam): filter results by flagged questions"`

---

## 驗收清單

- [ ] `pnpm test` 全綠;`node --test --experimental-strip-types frontend/src/lib/examFlagSync.test.ts` 全綠。
- [ ] `pnpm exec tsc --noEmit` 與 `cd frontend && pnpm build` 皆過。
- [ ] `PUT /api/exam/:sid/flag` 冪等(連送兩次同值 → 同樣 200)。
- [ ] 別人的 session → 403;不存在 session → 404;不屬於該場考試的 `question_id` → 404。
- [ ] 未作答題也能標記(`chosen IS NULL AND flagged = 1` 查得到列)。
- [ ] 關分頁重開、換瀏覽器,標記仍在且一致。
- [ ] DevTools offline 下 toggle 標記 → 畫面立即反映且不消失;恢復連線重進 session 後 server 也有了。
- [ ] 結果頁「標記」頁籤只列出標記題。
- [ ] 遷移只跑一次(`localStorage['exam:flags:synced:v1']` 存在後不再動作)。

## 風險與回滾

- **既有進行中的 session**:`DEFAULT 0` 讓舊列自動視為未標記,不會壞;分頁裡的舊標記由 Task 1.5 補救(範圍見該 task)。
- **雙裝置同時 toggle 同題**:`flagged_at` LWW,可能有一方被覆蓋。20 人自習用途可接受,不做 CRDT。
- **時鐘偏差**:`at` 由 client 送出,裝置時鐘大幅偏差會影響勝負判定。保守做法是拿掉 `body.at` 一律用 server `Date.now()`,代價是本機時間戳與 server 不一致、更易誤判「本機較新」。**預設採 client 時間戳**,與 highlights 現行做法一致(`highlights.ts:54-55`)。
- **回滾**:D1 `ADD COLUMN` 不易撤銷,但無人讀就是死重量;revert Task 1.2–1.7 的 commit 即回到現況,資料庫可留著。

## 成本

零新增服務。每次 toggle 一次單列 D1 UPDATE;對帳只在進入 session 時發生且複用既有 `/state` 回應,不多打 API。20 人 × 每場數十次標記遠低於 D1 免費額度。前端無新依賴。

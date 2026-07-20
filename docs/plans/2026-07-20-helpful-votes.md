# 詳解與留言的「有幫助」訊號 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 給討論串留言一個低成本的品質訊號(「有幫助」計數),讓真正解開疑惑的那一則能浮上來;共筆詳解不投票,改為顯示「貢獻者 / 版本數」的協作訊號。目的是讓好內容浮上來,不是比較人。

**Architecture:** 新增 `helpful_votes` 表,主鍵 `(user_email, target_type, target_id)` —— 主鍵本身即冪等保證。計數與「我投過沒」在既有 `GET /api/questions/:id/comments` 一次 JOIN 帶回(避免 N+1)。排序抽成 `worker/lib/helpful.ts` 純函式並 TDD。前端一顆 👍 計數按鈕,樂觀更新 + 失敗回滾。整體沿用「答案挑戰」既有的投票語彙與 UX。

**Tech Stack:** Cloudflare Workers (Hono) + D1;前端 React 18 + Vite + Tailwind + lucide-react。測試 `node --test`(`node:test` + `node:assert/strict`),指令見 `package.json:26`。不新增任何服務。

---

## 現況(file:line 佐證)

- **投票只存在於「答案挑戰」**:`challenge_votes` 定義於 `migrations/0011_answer_challenges.sql:45-56`,以 `UNIQUE(challenge_id, voter_email)` 保證一人一票;路由 `POST` / `DELETE /api/challenges/:cid/votes` 見 `worker/routes/challenges.ts:55-77`;`castVote` 用 `ON CONFLICT ... DO UPDATE` 達成冪等(`worker/lib/challenges.ts:253-264`),並在 `worker/lib/challenges.ts:245-247` 明文禁止提案人投自己的挑戰。
- **留言完全沒有品質訊號**:`comments` 表(`migrations/0001_initial_schema.sql:59-72`)只有 `parent_id / author_email / content_json / created_at`;list 端點 `worker/routes/comments.ts:14-26` 固定 `ORDER BY c.created_at ASC`,前端 `buildTree` 照回傳順序建樹(`frontend/src/components/CommentThread.tsx:22-34`),留言底部只有「回覆 / 編輯 / 刪除」(`frontend/src/components/CommentThread.tsx:242-254`)。
- **共筆詳解是會被改寫的活文件**:`explanations` 單列存 `content_json + version + editing_by/editing_until`(`migrations/0001_initial_schema.sql:36-44`),每次存檔 version+1 並寫快照到 `explanation_history`(`worker/routes/explanations.ts:69-90`;表 `migrations/0001_initial_schema.sql:47-56`),歷史端點 `worker/routes/explanations.ts:133-146`。
- **通知機制**:`notifications(kind, question_id, comment_id, actor_email, preview)`(`migrations/0001_initial_schema.sql:88-101`);留言 mention/reply 通知在 `worker/routes/comments.ts:71-102` 以 `DB.batch` 寫入;結案 fan-out 範例 `worker/lib/challenges.ts:597-632`;前端依 `kind` 分支於 `frontend/src/components/NotificationBell.tsx:145`。
- **渲染位置**:`CommentThread` 在 `frontend/src/routes/Question.tsx:1091`(桌機 tab)與 `:1230`(手機底部)各掛一次 —— 改元件即兩處生效。
- **投票 UI 樣式參考**:`frontend/src/routes/Challenges.tsx:56-70` 的 filter pill,與 `:113-116` 的「同意 N · 反對 N」計數行。
- **migration 現況**:目錄最後一支是 `migrations/0022_highlights.sql`。任務簡報寫「0024」,但 repo 實際只到 0022,故本計畫用 **`0023`**;實作前仍 `ls migrations/ | tail -3` 重新確認,若期間有人補號就往後順延。

## 非目標

- **不做排行榜、積分、徽章、個人得票統計頁**。20 人熟人讀書會,訊號用來排序內容,不用來比較人。
- 不做「反對 / 倒讚」—— 負向訊號在熟人圈的社交成本遠高於效益。
- 不改動 `challenge_votes` 或答案挑戰邏輯(挑戰是決議、helpful 是品質訊號,共用一張表只會弄髒狀態機)。
- 不做即時推播;沿用「下次載入看到 badge」。不對聊天大廳訊息投票(那裡已有 reaction)。

## 設計決策

**決策 1 — 詳解不投票,改顯示協作訊號。** 投票的語意是「我為這個**具體內容**背書」。詳解是單列可覆寫的活文件(`migrations/0001_initial_schema.sql:36-44`),任何人拿到 lock 就能整段改寫(`worker/routes/explanations.ts:69-82`)。若對 `question_id` 投票,票會**存活於它所背書的內容之外**——昨天 3 人覺得有幫助的那版今天可能已被改掉,票卻還掛著,成為誤導訊號。若改成「對特定 version 投票」語意乾淨,但票數每次存檔歸零,對持續小修的文件而言永遠是 0;更糟的是會誘導大家為保住票數而不去修,與共筆目的直接衝突。**結論:詳解不投票**,改在詳解分頁頁首顯示「N 人共筆 · 第 M 版」,由 `explanation_history` 聚合,零新表零新寫入。`target_type` 欄位仍保留(而非直接叫 `comment_id`),未來若要對 version 投票可無痛加值,但本計畫只實作 `'comment'` 並在 API 白名單擋掉其他值。

**決策 2 — 禁止自投。** 沿用 `worker/lib/challenges.ts:245-247` 的既有立場。API 回 403,前端在自己的留言上不渲染按鈕(只顯示計數)。

**決策 3 — 只在「首次獲得投票」發一次通知。** 每票都發 → 一則熱門留言連發 19 封;完全不發 → 作者不知道自己幫上忙,正回饋消失。折衷:**每則留言一生只發一次 `kind='helpful'`**。實作上不需新表 —— 寫入前 `SELECT 1 FROM notifications WHERE kind='helpful' AND comment_id=?`,有就跳過。preview 寫「有人覺得你的留言有幫助」,**不揭露投票人**(`actor_email` = NULL),避免變成人情債。

**決策 4 — 預設仍是時間序。** 討論串的可讀性來自時序;「最有幫助優先」是使用者主動切換的檢視,且**只重排 root 層**,子回覆永遠時序否則對話讀不通。排序含輕度時間衰減 `score = count / (ageDays + 2)^0.3`:沒有衰減時最早發的留言會永久霸榜,後來更好的回答永無出頭日;指數 0.3 是刻意的弱衰減(讀書會討論以週計,不需 HN 的 1.8)。**被採納者置頂**:該題有 `status='promoted'` 的挑戰且留言作者即該挑戰 `proposer_email` 時強制置頂 —— 社群已用行動認證過。

## 跨切面約定

- Auth 走 Cloudflare Access,handler 內只用 `c.var.email`,絕不從 body 讀身分。
- migration 只新增不改。純函式抽到 `worker/lib/*.ts`,測試同目錄 `*.test.ts`,先寫失敗測試。
- UI 沿用 scholarly/editorial:ink/cream + `accent`(#a8442a)。Tailwind `accent` **只有 DEFAULT/dark/light**,別寫 `accent-500`。無漸層、無玻璃擬態。
- 每個 task 獨立 commit。

---

### Task 1.1:migration + 排序純函式(TDD)

**Files:** Create `migrations/0023_helpful_votes.sql`、`worker/lib/helpful.ts`;Test `worker/lib/helpful.test.ts`

**Step 1 — migration**(先 `ls migrations/ | tail -3` 確認號碼):
```sql
-- Migration 0023: 「有幫助」訊號 (helpful votes)
-- 一人對一個 target 一票。PK 即冪等保證:重複 INSERT 走 ON CONFLICT
-- DO NOTHING,計數不會重複;撤回 = DELETE。target_type 目前只允許
-- 'comment'(API 層白名單)。共筆詳解刻意不投票 —— 見計畫「決策 1」。
CREATE TABLE helpful_votes (
  user_email   TEXT    NOT NULL REFERENCES users(email),
  target_type  TEXT    NOT NULL,          -- 'comment'
  target_id    TEXT    NOT NULL,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (user_email, target_type, target_id)
);
CREATE INDEX idx_helpful_target ON helpful_votes(target_type, target_id);
```
套用 `pnpm db:migrate:local`。

**Step 2 — 失敗測試** `worker/lib/helpful.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { helpfulScore, rankByHelpful } from "./helpful.ts";

const DAY = 86_400_000, now = 10 * DAY;

test("零票得零分,票數越多分越高", () => {
  assert.equal(helpfulScore({ helpful_count: 0, created_at: now }, now), 0);
  assert.ok(helpfulScore({ helpful_count: 3, created_at: now }, now)
          > helpfulScore({ helpful_count: 1, created_at: now }, now));
});

test("同票數時較新者分數較高(避免早發言者永遠壓死後發言者)", () => {
  assert.ok(helpfulScore({ helpful_count: 2, created_at: now }, now)
          > helpfulScore({ helpful_count: 2, created_at: now - 30 * DAY }, now));
});

test("被採納者強制置頂,即使零票", () => {
  const out = rankByHelpful([
    { id: "a", helpful_count: 9, created_at: now },
    { id: "b", helpful_count: 0, created_at: now, adopted: true },
  ], now);
  assert.deepEqual(out.map((r) => r.id), ["b", "a"]);
});

test("分數相同時比時間(較早者在前)", () => {
  const out = rankByHelpful([
    { id: "late", helpful_count: 0, created_at: now },
    { id: "early", helpful_count: 0, created_at: now - DAY },
  ], now);
  assert.deepEqual(out.map((r) => r.id), ["early", "late"]);
});

test("不改動輸入陣列", () => {
  const input = [
    { id: "a", helpful_count: 0, created_at: now },
    { id: "b", helpful_count: 5, created_at: now },
  ];
  rankByHelpful(input, now);
  assert.deepEqual(input.map((r) => r.id), ["a", "b"]);
});
```

**Step 3:** `node --test worker/lib/helpful.test.ts` → FAIL(找不到模組)。

**Step 4 — 實作** `worker/lib/helpful.ts`:
```ts
// 「有幫助」排序。純函式:不碰 D1、不讀 Date.now()(now 由呼叫端傳入)。
export type Rankable = { id: string; helpful_count: number; created_at: number; adopted?: boolean };

const DAY = 86_400_000;
const GRAVITY = 0.3;   // 弱衰減:讀書會討論以週為生命週期,不需 HN 的 1.8

export function helpfulScore(r: Pick<Rankable, "helpful_count" | "created_at">, now: number): number {
  if (r.helpful_count <= 0) return 0;
  const ageDays = Math.max(0, (now - r.created_at) / DAY);
  return r.helpful_count / Math.pow(ageDays + 2, GRAVITY);
}

export function rankByHelpful<T extends Rankable>(items: T[], now: number): T[] {
  return [...items].sort((a, b) => {
    if (!!a.adopted !== !!b.adopted) return a.adopted ? -1 : 1;
    const d = helpfulScore(b, now) - helpfulScore(a, now);
    return d !== 0 ? d : a.created_at - b.created_at;   // 同分比時間,早者在前
  });
}
```

**Step 5:** `node --test worker/lib/helpful.test.ts` → PASS。

**Step 6:** `git add migrations/0023_helpful_votes.sql worker/lib/helpful.ts worker/lib/helpful.test.ts && git commit -m "feat(helpful): helpful_votes table + pure ranking helper"`

---

### Task 1.2:API —— 投票 / 撤回 + list 一併帶回計數

**Files:** Create `worker/routes/helpful.ts`;Modify `worker/index.ts:85-87`、`worker/routes/comments.ts:14-26`

**Step 1 — 新路由** `worker/routes/helpful.ts`,形狀鏡射 `worker/routes/challenges.ts:55-77`:
```ts
import { Hono } from 'hono';
import type { AppContext } from '../types';
import { uuid } from '../lib/db';

// 掛在 /api/comments —— POST / DELETE /api/comments/:cid/helpful
export const helpfulRoutes = new Hono<AppContext>();

helpfulRoutes.post('/:cid/helpful', async (c) => {
  const cid = c.req.param('cid');
  const email = c.var.email;
  const now = Date.now();

  const target = await c.env.DB
    .prepare('SELECT author_email, question_id FROM comments WHERE id = ? AND deleted_at IS NULL')
    .bind(cid).first<{ author_email: string; question_id: string }>();
  if (!target) return c.json({ error: 'not found' }, 404);
  // 決策 2:禁止自投,同 challenges.ts:245-247。
  if (target.author_email === email) {
    return c.json({ error: 'cannot mark your own comment helpful' }, 403);
  }

  // PK 衝突即冪等:重複投票不重複計數,也不算「首次」。
  const res = await c.env.DB.prepare(
    `INSERT INTO helpful_votes (user_email, target_type, target_id, created_at)
     VALUES (?, 'comment', ?, ?)
     ON CONFLICT(user_email, target_type, target_id) DO NOTHING`
  ).bind(email, cid, now).run();

  if ((res.meta?.changes ?? 0) > 0) await maybeNotifyFirstHelpful(c.env.DB, { cid, target, now });
  return c.json({ ok: true, helpful_count: await helpfulCount(c.env.DB, cid), voted_by_me: true });
});

helpfulRoutes.delete('/:cid/helpful', async (c) => {
  const cid = c.req.param('cid');
  await c.env.DB.prepare(
    `DELETE FROM helpful_votes WHERE user_email = ? AND target_type = 'comment' AND target_id = ?`
  ).bind(c.var.email, cid).run();
  return c.json({ ok: true, helpful_count: await helpfulCount(c.env.DB, cid), voted_by_me: false });
});

async function helpfulCount(db: D1Database, cid: string): Promise<number> {
  const row = await db.prepare(
    `SELECT COUNT(*) AS n FROM helpful_votes WHERE target_type = 'comment' AND target_id = ?`
  ).bind(cid).first<{ n: number }>();
  return row?.n ?? 0;
}
```
`maybeNotifyFirstHelpful` 在 Task 1.3 實作;本 task 先放 `async function maybeNotifyFirstHelpful(..) {}` no-op stub,讓這個 commit 能獨立通過。

**Step 2 — 掛載**,`worker/index.ts` 於 `:87` 之後加 `app.route('/api/comments', helpfulRoutes);`(import 放在 challenges 那行旁)。

**Step 3 — list 端點一次撈完(避免 N+1)**,把 `worker/routes/comments.ts:16-24` 的查詢換成:
```ts
const { results } = await c.env.DB.prepare(
  `SELECT c.*, u.display_name, u.avatar_key,
          COALESCE(hc.n, 0) AS helpful_count,
          CASE WHEN mv.user_email IS NULL THEN 0 ELSE 1 END AS voted_by_me
     FROM comments c
     LEFT JOIN users u ON u.email = c.author_email
     LEFT JOIN (SELECT target_id, COUNT(*) AS n FROM helpful_votes
                 WHERE target_type = 'comment' GROUP BY target_id) hc ON hc.target_id = c.id
     LEFT JOIN helpful_votes mv
       ON mv.target_type = 'comment' AND mv.target_id = c.id AND mv.user_email = ?
    WHERE c.question_id = ? AND c.deleted_at IS NULL
    ORDER BY c.created_at ASC`,
).bind(c.var.email, id).all();
```
POST 端點回傳新建留言時(`worker/routes/comments.ts:114-120`)補 `helpful_count: 0, voted_by_me: 0` 兩個常數欄,讓型別一致。

**Step 4 — 驗證**(`pnpm dev`):
```bash
CID=$(curl -s -H 'X-Dev-Email: <admin>' localhost:8787/api/questions/114-001/comments | jq -r '.[0].id')
curl -s -X POST   -H 'X-Dev-Email: <other>'  localhost:8787/api/comments/$CID/helpful  # count=1
curl -s -X POST   -H 'X-Dev-Email: <other>'  localhost:8787/api/comments/$CID/helpful  # 仍為 1(冪等)
curl -s -X POST   -H 'X-Dev-Email: <author>' localhost:8787/api/comments/$CID/helpful  # 403 自投
curl -s -X DELETE -H 'X-Dev-Email: <other>'  localhost:8787/api/comments/$CID/helpful  # count=0
```

**Step 5:** `pnpm exec tsc --noEmit` 後 `git commit -m "feat(helpful): idempotent vote endpoints + counts in comments list"`

---

### Task 1.3:首次獲得投票才發通知

**Files:** Modify `worker/routes/helpful.ts`(補 stub)、`frontend/src/components/NotificationBell.tsx:145`

**Step 1 —** 沿用 `worker/routes/comments.ts:86-90` 的寫法實作:
```ts
// 決策 3:每則留言一生只通知一次,且不揭露投票人(actor_email = NULL),
// 避免在 20 人熟人圈變成人情債。notifications 自身即「是否通知過」的事實來源。
async function maybeNotifyFirstHelpful(
  db: D1Database,
  args: { cid: string; target: { author_email: string; question_id: string }; now: number },
): Promise<void> {
  const seen = await db.prepare(
    `SELECT 1 FROM notifications WHERE kind = 'helpful' AND comment_id = ? LIMIT 1`
  ).bind(args.cid).first();
  if (seen) return;
  await db.prepare(
    `INSERT INTO notifications
       (id, recipient, kind, question_id, comment_id, actor_email, preview, created_at)
     VALUES (?, ?, 'helpful', ?, ?, NULL, ?, ?)`
  ).bind(uuid(), args.target.author_email, args.target.question_id, args.cid,
         '有人覺得你的留言有幫助', args.now).run();
}
```

**Step 2 —** `NotificationBell.tsx` 既有的 `kind` 分支(`:145`)加一支 `helpful`:圖示 lucide `ThumbsUp`,文案「有人覺得你的留言有幫助」,點擊導到 `/q/<question_id>`,與 `mention`/`reply` 同路徑。

**Step 3 — 驗證:** 兩個不同 `X-Dev-Email` 對同一則留言各投一次 → `SELECT COUNT(*) FROM notifications WHERE kind='helpful' AND comment_id=?` 應為 **1**。

**Step 4:** `git commit -m "feat(helpful): one-time notification on a comment's first helpful vote"`

---

### Task 2.1:前端 —— 👍 計數按鈕(樂觀更新 + 回滾)

**Files:** Modify `frontend/src/components/CommentThread.tsx`(`Question.tsx:1091` 與 `:1230` 兩處自動生效)

**Step 1 —** `Comment` type(`:9-18`)加 `helpful_count: number;` 與 `voted_by_me: 0 | 1;`。

**Step 2 —** `CommentItem` 內加狀態,樂觀更新、失敗回滾、不重抓整串:
```tsx
const [helpful, setHelpful] = useState({
  count: comment.helpful_count ?? 0,
  mine: comment.voted_by_me === 1,
});
const [voting, setVoting] = useState(false);

const toggleHelpful = async () => {
  if (voting || isOwn) return;
  const prev = helpful;
  setHelpful({ count: prev.count + (prev.mine ? -1 : 1), mine: !prev.mine }); // 樂觀
  setVoting(true);
  try {
    const r = prev.mine
      ? await api.del<{ helpful_count: number }>(`/api/comments/${comment.id}/helpful`)
      : await api.post<{ helpful_count: number }>(`/api/comments/${comment.id}/helpful`, {});
    setHelpful({ count: r.helpful_count, mine: !prev.mine });   // 以伺服器為準
  } catch {
    setHelpful(prev);                                            // 回滾
  } finally { setVoting(false); }
};
```

**Step 3 — 樣式**,插在 footer(`:242-254`)最左,預設就是那排小字的一員,投過才上 accent:
```tsx
{isOwn ? (
  helpful.count > 0 && (
    <span className="inline-flex items-center gap-1 text-ink-400 dark:text-ink-500">
      <ThumbsUp size={13} /> {helpful.count}
    </span>
  )
) : (
  <button onClick={toggleHelpful} disabled={voting} aria-pressed={helpful.mine}
    title={helpful.mine ? '取消標記' : '這則留言幫到我了'}
    className={'inline-flex items-center gap-1 transition-colors disabled:opacity-50 ' +
      (helpful.mine ? 'text-accent' : 'hover:text-accent')}>
    <ThumbsUp size={13} className={helpful.mine ? 'fill-current' : undefined} />
    {helpful.count > 0 && helpful.count}
    <span className="sr-only">有幫助</span>
  </button>
)}
```
自己的留言只顯示計數(對應 API 的 403);零票時不顯示數字,版面保持安靜。

**Step 4 — 驗證:** `pnpm dev` 開 `/q/114-001`,對別人的留言按讚 → 即時 +1、圖示轉 accent;重整後仍在;再按一次歸零;自己的留言看不到按鈕。

**Step 5:** `git commit -m "feat(ui): unobtrusive helpful button on comments with optimistic toggle"`

---

### Task 2.2:前端 —— 「最有幫助優先」排序切換

**Files:** Modify `frontend/src/components/CommentThread.tsx`、`worker/routes/comments.ts`

**Step 1 —** list 查詢再補 `adopted` 欄(挑戰表 `migrations/0011_answer_challenges.sql:22-34`):
```sql
EXISTS (SELECT 1 FROM answer_challenges ac
         WHERE ac.question_id = c.question_id
           AND ac.status = 'promoted'
           AND ac.proposer_email = c.author_email) AS adopted
```

**Step 2 —** `CommentThread` 加 `sort` state(`'time' | 'helpful'`,預設 `'time'`),標題列右側兩顆 pill,樣式抄 `frontend/src/routes/Challenges.tsx:56-70`:
```tsx
{(['time', 'helpful'] as const).map((k) => (
  <button key={k} onClick={() => setSort(k)}
    className={'px-2.5 py-1 rounded text-xs transition ' + (sort === k
      ? 'bg-accent text-white'
      : 'bg-ink-100 dark:bg-ink-700 text-ink-600 dark:text-ink-300 hover:bg-ink-200 dark:hover:bg-ink-600')}>
    {k === 'time' ? '依時間' : '最有幫助'}
  </button>
))}
```

**Step 3 —** 排序**只作用在 root 層**,子回覆維持時序。在 `buildTree`(`:22-34`)之後套用:
```ts
const tree = useMemo(() => {
  const roots = buildTree(comments);
  return sort === 'helpful' ? rankByHelpful(roots, Date.now()) : roots;
}, [comments, sort]);
```
> 若 tsconfig path 不允許從 `frontend/` import `worker/lib/helpful.ts`,就在 `frontend/src/lib/helpful.ts` 放一份同內容,兩檔頂端互相註明「與 worker/lib/helpful.ts 同步」(參考 `ChatProvider.tsx` 對 emoji palette 的既有處理)。

**Step 4 — 驗證:** 對第 3 則留言投 2 票 → 切「最有幫助」它跳第一;切回「依時間」順序復原;子回覆兩種模式下都維持時序。

**Step 5:** `git commit -m "feat(ui): helpful-first sort toggle for root comments"`

---

### Task 3.1:詳解改顯示協作訊號(取代投票)

**Files:** Modify `worker/routes/explanations.ts`(`:133` 旁新增端點)、`frontend/src/routes/Question.tsx`(詳解分頁頁首)

**Step 1 —** 純聚合、無新表:
```ts
explanationsRoutes.get('/:id/explanation/stats', async (c) => {
  const row = await c.env.DB.prepare(
    `SELECT COUNT(DISTINCT updated_by) AS contributors, COALESCE(MAX(version), 0) AS versions
       FROM explanation_history WHERE question_id = ?`
  ).bind(c.req.param('id')).first<{ contributors: number; versions: number }>();
  return c.json(row ?? { contributors: 0, versions: 0 });
});
```

**Step 2 —** 詳解分頁頁首一行小字 `N 人共筆 · 第 M 版`(`text-xs text-ink-400 dark:text-ink-500`),點擊沿用既有版本歷史入口。**這是描述性事實,不是評價,也不排名。**

**Step 3 — 驗證:** 開一題已多次存檔的詳解,數字與 `GET /:id/explanation/history`(`worker/routes/explanations.ts:133-146`)的筆數吻合。

**Step 4:** `git commit -m "feat(explanation): contributor/version stats in place of voting"`

---

## 驗收清單

- [ ] `node --test 'worker/**/*.test.ts'` 全綠(含新的 `helpful.test.ts`)
- [ ] `pnpm exec tsc --noEmit` 通過;`cd frontend && pnpm build` 通過
- [ ] 重複 POST 同一則留言 → `helpful_count` 不變(冪等)
- [ ] 對自己的留言 POST → 403;前端該處不渲染按鈕
- [ ] `GET /api/questions/:id/comments` 只發一次查詢就帶回全部計數(`wrangler tail` 觀察無 N+1)
- [ ] 同一則留言被多人投票 → `notifications` 中 `kind='helpful'` 只有 1 筆
- [ ] 「最有幫助」:被採納者置頂;同票數較新者在前;子回覆維持時序
- [ ] 樂觀更新在 API 失敗時正確回滾(devtools 離線模式可驗)
- [ ] 深色模式下 accent 按鈕與計數對比度可讀
- [ ] 全站無新增排行榜 / 積分 / 徽章 / 個人得票頁

## 風險與回滾

- **訊號變成社交壓力**:零票留言可能讓作者不好受。緩解:零票不顯示數字(Task 2.1 Step 3),且無倒讚。若讀書會回饋不佳,前端拿掉按鈕即可,資料表留著無害。
- **排序參數失準**:`GRAVITY = 0.3` 是估計值。跑一週後若舊留言仍霸榜就調大、新留言太易插隊就調小 —— 因為是純函式,改一個常數 + 補一條測試,不動 API。
- **跨 worker/frontend 共用純函式**:若採複製而非 import,兩份可能漂移。緩解:兩檔頂端互指註解;行為權威在 worker 端測試。
- **回滾**:所有變更皆為新增(1 表、1 路由檔、2 端點、元件內區塊)。`git revert` 各 task commit 即可完整還原;`helpful_votes` 留在 D1 不影響任何既有查詢(空表零成本)。

## 成本

零新增服務。D1 一張表:20 人 × 每題數則留言,以 1000 題估上限亦僅數千列,遠低於 free tier 額度。新增 JOIN 走 `idx_helpful_target`,不增加 round-trip(反而消除 N+1 的可能)。無 Workers AI、無 R2、無 KV 呼叫。

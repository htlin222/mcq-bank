# 2048 休息小遊戲 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在站內加一個純休息用的 2048，每人各玩各的，棋盤與最高分存在獨立的
`Play2048` Durable Object，換裝置接得回來，並附一份全員最高分榜單。

**Architecture:** 三層互不知情 —— (1) `frontend/src/lib/game2048.ts` 是不依賴
React / fetch 的純函式引擎，rng 由呼叫端注入；(2) `frontend/src/routes/Play.tsx`
用 `useReducer` 持有狀態，鍵盤與觸控收斂到同一個 dispatch，debounce ~1s 推
Worker；(3) `worker/play-2048.ts` 的 SQLite-backed DO 存 `{state, best}`，
`worker/routes/play.ts` 負責驗證與榜單的 D1 join。資料流單向，DO 從不回推。

**Tech Stack:** TypeScript、Hono、Cloudflare Durable Objects (SQLite)、React 18、
Tailwind、`node --test`、Playwright WebKit。

**設計文件:** `docs/plans/2026-08-06-play-2048-design.md`

---

## Task 1: 遊戲引擎純函式

**Files:**
- Create: `frontend/src/lib/game2048.ts`
- Test: `frontend/src/lib/game2048.test.ts`

`pnpm test` 的 glob 是 `'worker/**/*.test.ts' 'frontend/src/lib/**/*.test.ts'`，
所以測試放這個路徑會自動被撿到，不需要改 `package.json`。

**Step 1: 寫失敗的測試**

重點是注入固定序列的 rng，讓「新磚落在哪」變成可決定的。測試用的 rng 工廠：

```ts
// 依序回傳給定的值,用完就回 0(落在第一個空格、生成 2)
function seqRng(...vals: number[]): () => number {
  let i = 0;
  return () => (i < vals.length ? vals[i++] : 0);
}
```

必測的行為：

```ts
test('一次移動中已合併的磚不再參與合併', () => {
  // [2,2,4,null] 左移 → [4,4,null,null],不是 [8,null,null,null]
});
test('合併發生在移動方向的前緣', () => {
  // [2,null,2,2] 左移 → [4,2,null,null]
});
test('沒有磚移動時不落新磚', () => {
  // 已靠左的盤面再左移 → board 完全不變、moved === false
});
test('分數等於本次所有合併結果之和', () => {});
test('新磚只落在空格,且是 2 或 4', () => {});
test('棋盤滿但仍有相鄰同值 → 不算 game over', () => {});
test('棋盤滿且四方向皆無合併 → game over', () => {});
test('合出 2048 時 won 為真,且仍可續玩', () => {});
test('四個方向的移動彼此對稱', () => {});
```

**Step 2: 跑測試確認失敗**

Run: `pnpm test 2>&1 | tail -20`
Expected: FAIL，`Cannot find module './game2048'`

**Step 3: 實作**

```ts
export type Board = (number | null)[];   // 長度 16
export type Dir = 'up' | 'down' | 'left' | 'right';
export type GameState = {
  board: Board; score: number; won: boolean; over: boolean;
};
export type Rng = () => number;

export const SIZE = 4;
export function newGame(rng: Rng): GameState
export function move(state: GameState, dir: Dir, rng: Rng): GameState & { moved: boolean }
export function isGameOver(board: Board): boolean
```

實作要點：
- 內部把每個方向都化約成「對一列做左滑」——取出該方向的四條線 → `slideLine`
  → 寫回。`slideLine` 是唯一有合併邏輯的地方，只需要正確一次。
- `slideLine` 用一個 `merged` 旗標擋掉連鎖合併。
- `move` 先算盤面，`moved` 為假就直接回傳原 state（不落新磚、不加分）。

**Step 4: 跑測試確認通過**

Run: `pnpm test 2>&1 | tail -10`
Expected: PASS，總數 = 419 + 新增數

**Step 5: Commit**

```bash
git add frontend/src/lib/game2048.ts frontend/src/lib/game2048.test.ts
git commit -m "feat(play): 2048 遊戲引擎純函式"
```

---

## Task 2: Play2048 Durable Object

**Files:**
- Create: `worker/play-2048.ts`
- Test: `worker/play-2048.test.ts`（只測純驗證函式，DO 本身不在 node:test 裡跑）
- Modify: `wrangler.toml`（binding + migration tag v3）
- Modify: `worker/index.ts`（export class）
- Modify: `worker/types.ts`（Env 加 `PLAY: DurableObjectNamespace<Play2048>`）

**Step 1: 先寫驗證函式的失敗測試**

`isValidState` 是這個 Task 唯一值得單元測試的部分（DO 的 SQLite 要 workerd
才跑得動，不進 `node --test`）。把它 export 出來單獨測：

```ts
test('拒絕長度不是 16 的 board', () => {});
test('拒絕不是 2 的次方的格值', () => {});
test('拒絕超過 131072 的格值', () => {});
test('拒絕負分與非整數分', () => {});
test('接受合法的開局盤面', () => {});
```

**Step 2/3: 實作 DO**

```sql
CREATE TABLE IF NOT EXISTS games (
  email      TEXT PRIMARY KEY,
  state      TEXT NOT NULL,
  best       INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

方法：`getGame(email)`、`saveGame(email, state, best)`（`best` 取
`MAX(舊, 新)`，由 DO 決定）、`leaderboard()` 回 `[{email, best, at}]`。

`wrangler.toml` 加：

```toml
[[durable_objects.bindings]]
name = "PLAY"
class_name = "Play2048"

[[migrations]]
tag = "v3"
new_sqlite_classes = ["Play2048"]
```

**Step 4: Commit**

```bash
git add worker/play-2048.ts worker/play-2048.test.ts wrangler.toml worker/index.ts worker/types.ts
git commit -m "feat(play): Play2048 Durable Object"
```

---

## Task 3: /api/play 路由

**Files:**
- Create: `worker/routes/play.ts`
- Modify: `worker/index.ts`（`app.route('/api/play', playRoutes)`）

三個端點，照 `worker/routes/state.ts` 的既有模式（`stub(c)` helper、
`c.var.email`）：

| 端點 | 回應 |
| --- | --- |
| `GET /api/play` | `{ state, best }`，沒玩過回 `{ state: null, best: 0 }` |
| `PUT /api/play/state` | 驗證後存，回 `{ ok: true, best }` |
| `GET /api/play/leaderboard` | `[{ email, name, avatarUrl, best, at }]` |

榜單的 D1 join 在**路由層**做，不在 DO 裡：DO 回 email + best，路由拿
email 清單去 `users` 表撈 `name` / `avatar_url`。查不到的人退回 email 的
local part 當顯示名。

**Commit:** `feat(play): /api/play 端點與榜單`

---

## Task 4: Play.tsx 頁面與入口

**Files:**
- Create: `frontend/src/routes/Play.tsx`
- Modify: `frontend/src/App.tsx`（`<Route path="/play" element={<Play />} />`）
- Modify: `frontend/src/routes/Profile.tsx`（低調入口）

要點：
- `useReducer` 持有 `GameState`；鍵盤方向鍵（`preventDefault`）與觸控滑動
  （門檻 30px）都 dispatch 同一個 action。
- 掛載時 `GET /api/play` 當初始值；之後 ~1s debounce `PUT`，
  `visibilitychange → hidden` 與 `beforeunload` 強制 flush。
- 磚塊用單一色相的明度階梯，不用原版的暖橘。
- **不要**把 `/api/play` 加進 `frontend/src/lib/sw-guards.ts` 的
  `CACHEABLE_API` —— 那是可變狀態，快取住會讓玩家永遠看到舊局。

**Commit:** `feat(play): 2048 頁面與個人頁入口`

---

## Task 5: e2e fixture 與 WebKit 冒煙測試

**Files:**
- Create: `frontend/e2e/fixtures/play.json`
- Create: `frontend/e2e/fixtures/play_leaderboard.json`
- Modify: `frontend/e2e/smoke.test.mjs`（`ROUTES` 加 `/play`）

fixture 檔名規則是路徑把 `/` 換成 `_`（見既有的
`questions_113-050_comments.json`）。fixture **不得含真實 email** ——
`smoke.test.mjs` 有一條永遠會跑的測試在守這件事。

`/play` 掛的是別處沒有的渲染型態：`useReducer` + 全域鍵盤/觸控監聽 +
debounce timer。斷言照既有標準：有渲染、無 uncaught `pageerror`，加一個
`expectText` 確認棋盤真的畫出來了。

Run: `pnpm test:webkit 2>&1 | tail -20`

**Commit:** `test(play): /play 的 e2e fixture 與 WebKit 冒煙測試`

---

## 收尾

1. `pnpm test` 全綠
2. `pnpm test:webkit` 全綠
3. push `feat/play-2048`，開 PR

**部署提醒：** 不要從這個 worktree 跑 `deploy.sh` —— `wrangler pages deploy`
會依當前分支名決定環境，worktree 永遠不在 `main` 上，前端會被送到 Preview
而 Worker 照常上 production，造成「新 Worker + 舊前端」的分裂。合併回 `main`
後從主 checkout 部署。

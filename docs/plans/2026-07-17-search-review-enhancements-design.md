# 搜尋體驗 + 複習篩選強化設計

**日期**：2026-07-17
**範圍**：複習模式搜尋導覽、搜尋排序/篩選、搜尋結果 local cache、搜尋紀錄（per-user D1）、複習作答篩選、題目頁 skeleton 依 layout 顯示。

## 現況（探索結論）

- 複習模式由 `ReviewIndex.tsx` → `YearList.tsx` → `Question.tsx` 三檔組成，無單一 `Review.tsx`。
- 搜尋是獨立 `Search.tsx` + `worker/routes/search.ts`（FTS5）。
- 「搜尋脈絡」靠 react-router history state 的 `fromSearch`（僅帶查詢字串），單題頁 prev/next 目前走**同年度**相鄰題（`Question.tsx:283-299`），非搜尋結果順序。
- 作答狀態資料 `times_seen`/`last_correct` 來自 `review_progress`，`/api/questions` 已 LEFT JOIN 回傳；但 `/api/search` **未**回傳。
- 桌機版面 `LayoutMode = "columns" | "tabs"`，存 `localStorage["review-layout-mode"]`；`QuestionDetailSkeleton` 目前固定畫 columns 版。
- 最新 migration：`0018`；新增用 `0019`。

## A. 搜尋結果導覽 + local cache（功能 1、2、4）

**module-level cache** `frontend/src/lib/searchCache.ts`：
```ts
type SearchCache = { key: string; hits: Hit[]; scrollY: number } | null;
```
- `key` = 正規化查詢字串（`?q=…&year=…&group=…&tags=…&sort=…&answered=…`）。
- `Search.tsx`：每次搜尋成功後 `set()`；元件 mount 時若 `get().key === 目前 URL 查詢` → 直接還原 `hits`（不打 API）並在 layout effect 還原 `scrollY`；離開頁面前記錄 `scrollY`。
- `Question.tsx`：`fromSearch` 命中 cache（`key === fromSearch`）→ 進入**搜尋導覽模式**：
  - prev/next 走 cache `hits` 陣列中目前 id 的上下一筆（跨年份）。
  - 按鈕文字：「上一題/下一題」→「上一個結果/下一個結果」。
  - 左上年份連結 icon `ChevronLeft` → `CornerLeftUp`。
  - 鍵盤 ←/→（`Question.tsx:425-438`）在此模式同樣走結果順序。
  - **退化**：cache 遺失（整頁重載、直接開 /q 連結）→ 回到同年度相鄰題 + 原文字/icon。

## B. 搜尋排序 + 作答篩選（功能 3）

`worker/routes/search.ts`：
- `SELECT … , rp.times_seen, rp.last_correct` + `LEFT JOIN review_progress rp ON rp.question_id = q.id AND rp.user_email = ?`（bind email）。
- 新 query 參數：
  - `sort=relevance|year`（預設 relevance；無 `q` 時本來就 year 排序）。`year` → `ORDER BY q.year DESC, q.number ASC`。
  - `answered=all|yes|no`：`yes` → `rp.times_seen > 0`；`no` → `rp.times_seen IS NULL OR rp.times_seen = 0`。
- `Search.tsx`：加「排序」「作答」兩個 `<select>`；`Hit` 型別加 `times_seen`/`last_correct`；結果列顯示作答狀態小圖示（沿用 `YearList` 的 Check/X 樣式）。

## C. 複習 YearList 作答篩選（功能 5）

`YearList.tsx`：
- 新 state `answerFilter: 'all'|'answered'|'unanswered'|'correct'|'wrong'`（本地，不進 URL，與現有 `groupFilter` 一致）。
- group filter 那排 button **下方**再開一排 button（同樣式）。
- 套進既有 `visible = items.filter(...)`：重用 `answered = (times_seen ?? 0) > 0`、`correct = answered && last_correct === 1`。
- 每種 filter 計數 useMemo（比照 group `counts`）。

## D. 搜尋紀錄 per-user D1（功能 6）

Migration `0019_search_history.sql`：
```sql
CREATE TABLE search_history (
  user_email TEXT NOT NULL,
  query      TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_email, query)
);
CREATE INDEX idx_search_history_recent ON search_history(user_email, created_at DESC);
```
- `search.ts`：`q` 非空時 `INSERT … ON CONFLICT(user_email, query) DO UPDATE SET created_at = excluded.created_at`（單趟請求內順手寫，fire-and-forget，失敗不影響搜尋回應）。
- 新端點：
  - `GET /api/search/history?limit=10` → 最近查詢（`ORDER BY created_at DESC`）。
  - `DELETE /api/search/history`（清全部）與 `DELETE /api/search/history?query=…`（清單筆）。
- `Search.tsx`：搜尋框 focus 且 `q` 為空時下拉最近查詢；點一下帶回並搜尋；每筆可 ✕ 刪除。

## E. Skeleton 依 layout（功能 7）

`QuestionDetailSkeleton`（`components/Skeleton.tsx`）讀 `localStorage["review-layout-mode"]`：
- `columns`（預設）→ 現有雙欄骨架。
- `tabs` → 單欄全寬骨架：頂部一條 5-tab 佔位 + 下方單一內容卡（題幹＋選項）。
- key 常數與 `Question.tsx` 的 `LAYOUT_KEY` 同值（`"review-layout-mode"`）；為避免耦合，Skeleton 內以字面字串讀取並註解來源。

## 測試 / 驗收

- 搜尋 → 開題 → 返回：結果與捲動位置即時還原（無 loading 閃爍）。
- 搜尋模式單題頁：按鈕字樣、CornerLeftUp、prev/next 走結果順序（跨年份）。
- 搜尋排序切 year、作答切已/未作答，結果正確。
- YearList 四種作答篩選 × 內科/共同交集正確、計數正確。
- 搜尋紀錄：搜尋後 focus 空搜尋框看到該筆；跨裝置（同帳號）可見；刪除生效。
- 題目頁 loading：tabs 偏好者看到單欄骨架、columns 看到雙欄骨架。

## 不做（YAGNI）

- 搜尋紀錄不做「熱門搜尋」聚合、不做全文歷史頁。
- local cache 不進 sessionStorage（記憶體即可，重整失效可接受）。
- 搜尋導覽不做無限捲動載入更多再接續 prev/next。

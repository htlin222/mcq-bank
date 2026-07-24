# 技術債

已知債務、風險評估與償還建議。原則：**考前只還會咬人的債**，其餘記帳。

真的咬過人的坑另見 [踩過的坑 Gotchas](Gotchas)。

## 高優先（可能咬人）

### 1. 前端元件層仍無測試
純函式測試已補齊（2026-07-20：287 個 worker + 79 個前端測試），但**只涵蓋純函式**。React 元件、effect 生命週期、TipTap 整合完全沒有測試，而當天最貴的兩個 bug 正好都在這一層：個人筆記的無限 render 迴圈、自動挖空的 AI 呼叫失敗——**兩者發生時全部測試都是綠的**。

補的優先順序：`AnnotatableContent`（effect 依賴與 setContent 時機）、`Exam.tsx`（計時器 × tutor mode × 標記三組狀態交錯）。需要引入元件測試框架，目前 repo 沒有。

### 2. 部署正確性仰賴人工判斷
CI 的 path gate 讓「同時動到 worker 與 frontend 的推送」兩邊都跳過，**且以 success 收場**。目前靠人記得手動部署。應改成：混合推送時明確 fail，或改為循序部署，不要用綠勾表示「什麼都沒做」。

### 3. K-type（組合題）資料品質
早期 importer 把 K 型題選項壓平，`years/*/batches` 內的原始資料受影響。113 已修復，但**只有 110/111/113 有 docx ground truth**；其餘年份無從機器核對，只能靠成員讀到怪題時回報（challenge 機制承接）。

### 4. Roster 欄位寫死
Google Sheet CSV 的 email 欄位 hardcode 在 column index 3（`scripts/sync-access.ts:194`）。Sheet 改版會讓每日 cron 同步靜默失效或同步錯欄位。應改成讀 header row 或搬進 `config.toml`。

## 中優先

### 5. Service worker 已上線但未經真人驗證
PWA（2026-07-20 上線）的三道 Access 防線有 15 個單元測試，但**飛航模式、session 過期後開 app、實機加到主畫面都沒有真人測過**。SW 是最難收回的前端技術：回滾用的 `sw-kill.js` 已備妥且已加入 Access bypass，**但從未演練過**。至少該做一次「故意部署壞版本 → 用 sw-kill 救回」的演習。

### 6. 系統裡有兩套「今天」
FSRS 佇列用凌晨 4 點 rollover（`worker/lib/due-window.ts`），heatmap 與進度預估用 UTC+8 午夜（`worker/lib/activity.ts`）。兩套各自都正確——熬夜讀書不該在 session 中途換一批卡；活動日曆該對齊日曆日——但極易誤用。已在檔頭註明，長期應收斂成兩個具名概念（如 `studyDay` 與 `calendarDay`）而不是兩段散落的邏輯。

### 7. `attempts` 沒有回填歷史
2026-07-20 引入 `attempts` 事件表時刻意不回填——舊資料只有聚合值，回填等於捏造時間戳並污染中位數。代價：**修好的 heatmap 在 0023 之前的日期是空白的**，選項分布統計初期票數也偏少（靠 `review_progress.last_chosen` 補）。這是有意識的取捨，不是遺漏；若日後要補，方案是混合 UNION 而非造假。

### 8. 詳解覆蓋不均 + 種子詳解品質
早年份詳解多為 AI 產生的種子（`seed-explanations.py`），品質參差；polish pipeline（`polish_batch.py`）在批次償還中，但缺一個「哪些題還沒 polish / 沒人審過」的 dashboard。

### 8b. 冪等性是 opt-in,前端得逐一接線
`request_dedup`（0032）讓帶 `Idempotency-Key` 的重送安全 replay，但**沒帶 key 就完全沒保護**（刻意向後相容）。真正的冪等取決於**前端每個 append / increment 動作都實際送出穩定 key**——漏接一處，那條路徑的重複投遞照樣污染 `attempts` / 重複留言。目前只有部分動作接了；需要一份「哪些寫入動作已帶 key」的對照，並在新增寫入端點時預設要求。`request_dedup` 也還沒有 TTL 清理 cron（`created_at` 有 index，但無人 drain 舊列）。

### 8c. 教科書引用只到 Phase 1;回饋閉環未建
「選字問 Wintrobe」上線的是純 FTS lookup（Phase 1）。設計裡的 `citation_feedback` 回饋表、夜間聚合 re-rank（Phase 2）、Vectorize 逐頁語意層（Phase 3）**都還沒做**——目前排序完全靠 bm25，沒有任何回饋反哺，也無從量測「跳錯頁」的比例。這是有意的階段性取捨（回饋良好就永遠不做 Phase 2/3），但代價是**現在沒有數據能判斷該不該做**。另外教科書拆冊 / OCR / linearize 是一次性手動前置，尚無腳本封裝。

### 8d. 筆記連結建議的新鮮度滯後
派生快取只在 `needs_relink=1` 時重算：一則**已算過**的筆記不會因為別處新增了相關筆記/題目而自動刷新，要等它自己被再編輯或夜間 cron 掃到。方向偏保守（寧可少連不亂連，符合避免連結爆炸的目標），可接受；若要更即時，寫入端可 bounded-cascade 標記共享詞的其他自有筆記（未實作）。

### 9. Scripts 目錄野蠻生長
`scripts/` 已有 25+ 支一次性 / 批次工具（enrich、polish、restore、backfill…），彼此約定散落。`aggregate-batches.ts`、`apply-oe-verdicts.py` 等含重要 domain 邏輯卻無文件。至少要在每支檔頭寫用途與 danger level（哪些會寫 prod DB）。

### 10. `worker-configuration.d.ts` 肥大
自動生成檔已達 ~500KB 並進了 git。考慮 gitignore + 在 setup 流程重生成，或固定 wrangler types 版本減少 churn。

## 低優先（記帳即可）

### 11. `users.updated_at` 是 `NOT NULL` 且無 `DEFAULT`
任何省略該欄的 `INSERT OR IGNORE` 會**靜默插入 0 列卻回報成功**。已查核三個 insert 點（`auth.ts`、`roster-sync.ts`、`sync-access.ts`）全部正確綁值，**所以這不是線上 bug**，只是寫臨時 SQL 時的地雷（曾害人 debug 一輪）。SQLite 不能 in-place 加 default，修它要整表重建一張被大量 FK 參照的表——風險大於收益，**決定不修**。

### 12. 自動挖空的密度是猜的
關鍵詞數量（25–40）、去重上限（50）、輸入視窗（6000 字）都是估的，沒有依實際閱讀體驗校準。調整成本極低（改常數 + bump `CLOZE_PROMPT_VERSION` 讓快取失效），但需要真人回饋。

### 13. 匯出的 CSV 未實測匯入 Anki
欄位與結構已有測試鎖住，但沒有真的拖進 Anki 匯入過；notetype `血專` 是否存在於使用者 collection 也未確認。`.apkg` 與 PDF 明確列為非目標（Worker 內手刻 SQLite + zip 不可行；PDF 需 5–15 MB CJK 字型）。

### 14. Pessimistic lock 的極端情況
鎖續期靠前端每 60 秒打一次；筆電闔蓋、網路斷線會留下最長 5 分鐘的殭屍鎖。對 20 人規模可接受；若升 Yjs/DO（見 [Roadmap](Roadmap)）此債自然消失。

### 15. 未追蹤的產出物
`docs/manual.html`、`frontend/public/manual.html`、`manual.pdf`（4.6MB）等產出物在 repo 根部且部分未追蹤——決定：進 git（小的）或 gitignore + 產生腳本（大的），不要懸著。

### 16. 通知無即時推播
@mention 通知靠下次載頁時拉 badge。設計上「夠用就好」，但若成員反映錯過討論，再評估 polling 或 SSE（注意 Workers 免費額度）。

### 17. Telegram 推播的規模上界寫死
每小時 cron `runPushTick` 單次上限 50 人以防爆量；20 人規模綽綽有餘，但這是常數而非依人數推導，且外部依賴（BotFather token、webhook secret、`[[routes]]` 的 `/tg/*`）是一次性手動步驟，換 fork 時容易漏。三者未設時 worker 走 no-op / 501（不會壞站），但也**不會有任何錯誤提示說「你忘了設 Telegram」**——靜默停用是刻意的，代價是排查時沒有線索。

## 償還紀錄

| 日期 | 債 | 修法 |
|---|---|---|
| 2026-07-20 | 完全沒有自動化測試 | 九功能開發全程 TDD；純函式一律先抽出再測。287 worker + 79 frontend |
| 2026-07-20 | 使用者可控的 `IN (?)` 無上限 | `worker/lib/sql-params.ts` 集中 `chunkParams` / `parseTagList`；成因見 [Gotchas](Gotchas) |
| 2026-07-20 | `/heatmap` 嚴重低估活動量 | 原本數 `review_progress.last_seen_at`（每題一列、會被覆寫），一天做 10 題只算 1 次；改數 `attempts` |
| 2026-07-20 | FSRS 新卡無每日上限 | 逐年 deck 與 `/due` 共用同一套日界與 `remainingNewToday`，避免 Anki 新手雪崩 |
| 2026-07-20 | 未作答即可讀到全體正確率 | 與選項分布走同一道 gate；無方向性的人數仍開放 |
| 2026-07-20 | AI 錯誤被吞成空結果 | 記 log、區分 `ai_error` / `ai_empty`、失敗降級重試 |
| 2026-07-20 | 自動挖空重整就消失 | 關鍵詞本來就存在 D1，缺的是開關狀態；補 `cached_only=1` 還原且不重複計費 |
| 2026-07-20 | 個人筆記畫記 popup 失效 | effect 依賴從物件識別改成內容雜湊，解掉無限 render 迴圈 |
| 2026-06 | importer 覆蓋社群升級答案 | `fix(import): never clobber community-revised answers`；加 `db:pull` 鏡像工具 |
| 2026-06 | error detail 外洩 + CORS 過鬆 | `fix(security): stop error-detail leakage and tighten CORS/headers` |
| 2026-05/06 | 113 K-type 壓平 | 修 importer + 依 docx ground truth 修資料 |
| 2026-05 | `/mcq` 共享金鑰 | per-user HMAC key + 自助 `.skill`（05-26 design） |

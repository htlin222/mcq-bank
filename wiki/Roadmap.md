# 路線圖

北極星：**2026 血腫次專科考試前**，讓 20 位成員把 11 年考古題讀完、詳解共筆補齊、錯題複習閉環。首頁倒數計時就是 deadline。

## 近期（考前衝刺）

- **詳解講義批次**：用 `slide-deck` skill 把整年題目產成黑白極簡 16:9 詳解講義（PDF + HTML + 逐字稿）；114 年批次進行中（`scripts/slide_batch.py` 可續跑）。
- **答案品質稽核**：以 OpenEvidence（`verdict-by-oe` 流程）逐題複核有爭議的官方答案，經 answer challenge 機制升級社群答案（例：114-073 已由 B 改 D）。
- **詳解覆蓋率**：補齊尚無共筆詳解的題目（`polish-explanations` / `seed-explanations` pipeline）。

## 中期（考季後、下一屆前）

- **年度換版**：exam date、roster、新一年題目匯入的 fork 流程文件化——這個 codebase 已泛用化（config.toml 驅動），目標是任何科別讀書會 15 分鐘內能開新站。
- **K 型題（組合題）資料修復**：importer 曾把 K-type 題壓平，113 已修，但只有 110/111/113 有 docx ground truth——其餘年份需要另找來源核對。
- **元件層測試**：純函式測試已於 07-20 補齊（287 worker + 79 frontend），但 React 元件與 effect 生命週期仍無測試——當天最貴的兩個 bug 正好都在這一層，且發生時測試全綠。優先補 `AnnotatableContent` 與 `Exam.tsx`。詳見 [Tech Debt](Tech-Debt)。
- **部署流程收斂**：CI path gate 會讓混合推送兩邊都跳過卻回報 success，目前靠人記得手動部署——應改成明確 fail 或循序部署。

## 已完成（原列於此，2026-07 落地）

- **作答資料細粒度**：`attempts` 事件表成為唯一真相來源，撐起每題計時、配速報告與選項分布統計。
- **自訂測驗產生器**：狀態 × 範圍 × 題數 × 計時/tutor 的組卷畫面，沿用既有 exam session 機制。
- **PWA 離線閱讀**：可安裝、通勤可讀；離線作答佇列刻意不做（重送會污染 `attempts`）。
- **筆記關聯連結建議**（0030）：受控詞表 + IDF 的零 AI 連結建議，夜間 cron 有預算 drain。
- **冪等性層**（0032）：`Idempotency-Key` + `request_dedup`，向後相容地讓 append/increment 端點可安全重送。
- **Telegram 出題機器人**（0031）：綁定帳號、每日推題、聊天內測驗，計入同一份 FSRS / `attempts` 進度。
- **教科書引用「選字問 Wintrobe」Phase 1**（0033）：教科書拆冊匯入 + 全站選字 → 頁面級 BM25 lookup → 跳頁高亮，純規則式 FTS（長/低分才補一手 AI 精煉）。

## 長期（保留的升級路徑，未承諾）

- **真・即時共編**：把 pessimistic lock 換成 Yjs CRDT + TipTap binding，每個 question_id 一個 Durable Object 存活 Y.Doc，定期 snapshot 回寫 `explanations.content_json`。D1 schema 不用改。**代價：Workers Paid $5/月起**——上線前必須明確決策。
- **教科書引用 Phase 2/3**（選配，由回饋觸發）：`citation_feedback` 回饋鈕 + 夜間聚合對 BM25 做輕量 re-rank（純 SQL，比照 helpful_votes）；再不足才上 Vectorize 逐頁語意層（~2,000 向量，仍在免費 500 萬維度內）與 reranking。**只有當 Phase 1 純 FTS 回饋顯示漏召回敘述段落時才做**——回饋良好就永遠不做。
- **AI 深化**：Workers AI 目前只做輔助（詳解摘要、tag 建議、教科書長選取的精煉查詢）；若用量成長，走 cache（KV）→ async queue → 付費方案的順序升級。
- **`/mcq` skill 生態**：per-user HMAC key + 自助 `.skill` 下載已上線；後續可考慮開放唯讀 API 給其他工具（Anki sync 已有 `ts-fsrs` + migration 0012 基礎）。

## 明確不做

- App 層帳號系統（Access 已解決）。
- 公開題庫 / 對外開放（法律與授權考量，題目屬考選部）。
- 為了「看起來現代」的 UI 改版——editorial 風格是刻意的。

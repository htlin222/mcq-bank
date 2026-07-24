# 開發計畫

目前的工作項目與設計文件索引。歷史脈絡看 git log（2026-05-23 首 commit 當天即上 prod，之後以小步快跑疊代）。

## 進行中

| 項目 | 狀態 | 備註 |
|---|---|---|
| 114 年詳解講義批次（slide-deck） | 進行中，可續跑 | `scripts/slide_batch.py`；產物在 `slides/{YEAR}/{NNN}/`（gitignored） |
| OpenEvidence 答案稽核 | 逐題進行 | `verdict-by-oe` 流程；改答案走 challenge 機制留痕 |
| 詳解 polish pipeline | 批次進行 | `polish_batch.py` + `scripts/promote-polished.py` |

## 已完成的主要里程碑（節錄）

- **核心系統上線**（05-23）：複習模式、全真作答、共筆詳解（lock + 版本歷史）、討論串 + @mention、R2 圖片、Access Zero Trust。
- **複習班講義**（05-30 設計 → 上線）：EmbedPDF 閱讀器、個人 highlight / sticky note / 頁面錨定筆記本、選字popup（Highlight / AI 解釋 / OpenEvidence / 複製到筆記）、slide 快照、全文搜尋（PDF + 筆記，FTS5）、縮圖側欄、deep-link。
- **個人筆記 + @題號引用**（05-23 設計）：私人筆記 tab、`@114-001` cross-reference。
- **`/mcq` skill + per-user keys**（05-26 設計）：HMAC 衍生金鑰、`/profile` 自助下載 `.skill`、無共享密鑰。
- **答案挑戰系統**：多重並行 challenge（每個提議字母一個）、提案人可編輯理由、升級卡片 + 狀態篩選、升級後 importer 不回寫。
- **FSRS / Anki**（migration 0012）：`ts-fsrs` 間隔複習基礎。
- **品質收尾**：skeleton loaders、詳解 spoiler 模糊、A–E 鍵盤作答、雙欄獨立捲動、匿名動物頭像、安全強化（CORS/headers、error-detail 不外洩）。
- **實證學習功能**（07-18）：語意交錯練習（Vectorize）、答前信心校準、自動挖空、弱點概念聚類地圖。
- **九功能齊發**（07-20）：以五波平行分支開發並逐波合併——每題作答計時 + `attempts` 事件表、留言「有幫助」訊號、選項分布統計、跨年份到期佇列、自訂測驗產生器、每週目標與進度預估、考試標記跨裝置同步、App 內匯出、PWA 離線閱讀。同批修掉 heatmap 低估活動量、FSRS 新卡無上限、`IN (?)` 參數無上限等既有 bug。教訓見 [踩過的坑](Gotchas)。
- **筆記關聯連結建議**（07-21，migration 0030）：筆記側欄「🔗 你可能想連結」。**全確定性 SQL、零 Workers AI**——受控詞表（沿用 `question_tags`）+ IDF 加權比對，寫入只設 `needs_relink=1` 旗標、讀取惰性單則計算、夜間 cron `rebuildVocab` + `drainRelinkQueue` 有預算 drain。私人筆記只連本人資源（SQL 層 `user_email` 紅線守住 0009 隱私）。
- **冪等性層**（07-21，migration 0032 `request_dedup`）：`Idempotency-Key` header + `worker/lib/idempotency.ts`。**完全向後相容**——沒帶 key 時線上路徑零改變；帶 key 時 append / increment / 外部副作用（`attempts`、留言、FSRS 推進、feedback issue…）重送即 replay 既有結果。前端一次使用者動作用 `useRef` 產一個穩定 UUID、重送沿用同一個。全端點冪等盤點見設計文件。
- **Telegram 出題機器人**（07-22，migration 0031）：綁定既有帳號（app 產一次性 code → deep link `t.me/<bot>?start=<code>` 綁 `chat_id ↔ email`）、每小時 cron 依各人本地時段推每日題、聊天內 inline keyboard 作答即時揭曉、`/quiz` 選年份開進行式小測驗。**作答走與網頁 anki 複習同一寫入路徑**（推進 FSRS + `attempts`），與網頁同一份學習進度。webhook 掛 `/tg/webhook`（避開 Access，`secret_token` 常數時間比對）。
- **教科書引用「選字問 Wintrobe」**（07-23，migration 0033）：把英文血液學教科書（Wintrobe 15e）按章節拆冊匯入為 `lecture_docs(kind='textbook')`，逐頁文字沿用既有 `lecture_pages_fts`。**全站選字 popup**（`useTextSelection` + portal，掛 `App.tsx` 根部）→ `POST /api/textbook/lookup` BM25 找最相關頁 → 跳 `/lectures/:slug?page=N` + snippet 高亮。Phase 1 以規則式 FTS 打底（OR 串接 token，實測嚴格優於 AND），僅在長選取 / 低分時才補一手 AI 精煉查詢；回饋加權 re-rank 與 Vectorize 語意層列為 Phase 2/3（由回饋數據決定）。同批 reader 加教科書 tab（Wintrobe 目錄 nested accordion）、章節切換器、PDF 手掌拖曳工具 + 鍵盤快捷鍵、全螢幕。

## 設計文件索引（repo 內 `docs/plans/`）

| 文件 | 主題 |
|---|---|
| `2026-05-23-notes-and-question-refs-design.md` | 個人筆記、已做筆記 category、@題號引用 |
| `2026-05-26-mcq-skill-api-design.md` | `/mcq` 唯讀 API + 可散佈 skill（共享金鑰版，已被下文取代 auth 部分） |
| `2026-05-26-mcq-per-user-keys-design.md` | per-user HMAC 金鑰 + 自助 `.skill` 下載 |
| `2026-05-30-review-lectures-design.md` | 複習班講義：EmbedPDF、個人註記、筆記本 |
| `2026-05-30-review-lectures.md` | 上述功能的逐 task 實作計畫 |
| `2026-07-17-search-review-enhancements-design.md` | 搜尋與複習體驗強化 |
| `2026-07-18-evidence-based-study-enhancements.md` | 交錯練習、信心校準、自動挖空、弱點地圖 |
| `2026-07-20-feature-backlog-index.md` | 九功能提案總覽與跨計畫共同約定（**先讀這份**） |
| `2026-07-20-custom-test-builder.md` 等 9 份 | 各功能的逐 task 實作計畫，索引見上一列 |
| `2026-07-21-note-link-suggestions-design.md` | 筆記關聯連結建議：受控詞表 + IDF、寫入旗標 / 讀取惰性 / 夜間 drain（已實作，0030） |
| `2026-07-21-idempotency-audit.md` | Worker 寫入路徑冪等性盤點 + `Idempotency-Key` / `request_dedup` 設計（已實作，0032） |
| `2026-07-22-telegram-bot-design.md` | Telegram 出題機器人：綁定、webhook、每日推播、聊天測驗（已實作，0031） |
| `2026-07-23-textbook-citations-design.md` | 教科書引用「選字問 Wintrobe」：全站選字 popup + 頁面級 BM25 lookup + 三層漸進呈現（Phase 1 已實作，0033） |

新的重大功能請沿用此模式：先在 `docs/plans/` 寫 design doc（brainstorm 決策要 lock 下來），再寫逐 task 實作計畫，實作時逐 task commit。

## 工作方法備忘

- **測試**：`node --test` 跑 `worker/**/*.test.ts`（`pnpm test`）；前端純函式測試同目錄放 `*.test.ts`，用 `node --test --experimental-strip-types` 跑（`frontend/tsconfig.json` 已 exclude）。純邏輯一律先抽成函式再測。
- **但測試綠不等於功能會動**——元件與整合層仍無測試。改完 AI / 生命週期相關的東西，用 `wrangler dev` + `curl -H "X-Dev-Email: …"` 實打一次。見 [踩過的坑](Gotchas)。
- Migration 只加不改；schema 演進見 `migrations/`（目前 0001–0033）。**平行開發前先全域分配編號**，否則每條分支都會挑到同一號（0023 曾六份計畫同時搶號，見 [Gotchas](Gotchas)）。
- 會超出 Cloudflare free tier 的功能必須在計畫階段明講。
- 同時動到 `worker/` 與 `frontend/` 的推送**不會自動部署**（CI path gate 互相排除，且以 success 收場），要手動部署兩邊。

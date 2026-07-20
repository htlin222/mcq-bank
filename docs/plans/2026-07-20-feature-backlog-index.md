# 2026-07-20 功能提案總覽

九份彼此獨立的實作計畫,來自一次針對「這個題庫還缺什麼(對照商用題庫的業界標配)」的盤點。

判讀結論:本專案在**共筆詳解、討論、實證學習法**這條線上已經超過多數商用題庫(UWorld 沒有共筆、AMBOSS 沒有信心校準、Anki 沒有社群裁決答案);缺的是題庫最成熟的另一面 —— **作答工廠**:出題設定、作答資料的細粒度、以及作答後的診斷。以下排序反映這個判讀。

## 跨計畫共同約定

**migration 編號是佔位符,不是承諾。** 撰寫當下 `migrations/` 最後一支是 `0022_highlights.sql`,所以多份計畫都寫 `0023_*` —— 它們是**獨立的、沒有實作順序**,誰先做誰就是 0023。動手前一律:

```bash
ls migrations/ | sort | tail -1        # 取真正的最後一號
```

然後把該計畫內的 migration 檔名一併改掉。**不要**照本文件的順序推斷編號。

其餘共同約定(每份計畫內也各自重述):auth 一律走 Cloudflare Access 的 `c.var.email`;migration 只新增不改已套用的;per-fork 值走 `config.toml`;R2 不公開;UI 維持 scholarly/editorial(ink/cream + 單一 accent,Tailwind 的 `accent` 只有 DEFAULT/dark/light)。

## Tier 1 — 業界標配,目前沒有

| # | 計畫 | 一句話 | migration |
|---|---|---|---|
| ① | [自訂測驗產生器](2026-07-20-custom-test-builder.md) | 狀態(未做/做錯/標記)× 範圍 × 題數 × 計時/tutor 的組卷畫面 | `0023_custom_test_sessions` |
| ② | [選項分布統計](2026-07-20-answer-choice-distribution.md) | 「62% 的人選 B」— 陷阱分析,資料已存在 | 僅索引 |
| ③ | [每題作答時間與配速](2026-07-20-per-question-timing.md) | 逐次作答 log + 配速診斷;補上缺失的 `attempts` | `0023_attempts` |

## Tier 2 — 對 20 人共筆社群槓桿最大

| # | 計畫 | 一句話 | migration |
|---|---|---|---|
| ④ | [「有幫助」訊號](2026-07-20-helpful-votes.md) | 留言投票讓好內容浮上來(詳解刻意不投票,理由見內文) | `0023_helpful_votes` |
| ⑤ | [考試標記跨裝置同步](2026-07-20-exam-flag-sync.md) | 標記目前存 sessionStorage,關分頁就沒了 | `0023_exam_answer_flag` |
| ⑥ | [每週目標與進度預估](2026-07-20-study-goals-and-pacing.md) | 「依近 7 天速度,考前 22 天做得完」 | `0023_study_goals` |
| ⑦ | [跨年份統一到期佇列](2026-07-20-unified-due-queue.md) | FSRS 目前鎖在 `/anki/:year`,缺一個總佇列 | 不需要 |

## Tier 3 — 平台層

| # | 計畫 | 一句話 | migration |
|---|---|---|---|
| ⑧ | [PWA 與離線閱讀](2026-07-20-pwa-offline.md) | 加到主畫面 + 通勤離線讀;核心難點是 SW × Access | 選配 |
| ⑨ | [App 內匯出](2026-07-20-in-app-export.md) | 帶著題目 + 詳解 + 自己的筆記走;先做 Markdown/CSV,樣式基準是 [`mcq-to-anki`](https://github.com/htlin222/mcq-to-anki) | 不需要 |

## 刻意不做

**排行榜 / 積分 / 徽章** —— 20 人熟人讀書會,公開排名是壓力不是動力,學習效果證據也薄弱;既有的共筆與答案挑戰投票已經是更健康的版本。**Image occlusion**(血液腫瘤影像題比例低,ROI 差)、**TTS**、**新手導覽**(20 人、已有 `manual.html`)同理。

## 撰寫過程中順帶發現的既有問題

這幾項與上述功能無關,是**現在就存在**的行為,已寫進對應計畫:

- **`/heatmap` 低估活動量** —— 數的是 `review_progress.last_seen_at`(每題一列、會被覆蓋),所以一天做 10 題只算 1 天 1 次。見 ③。
- **`api.ts:37` 會把 Access 登入頁當成功資料回傳** —— session 過期時 fetch 跟隨 302,`res.ok === true`,JSON parse 失敗後純文字被塞進 `data`。見 ⑧。
- **跨年份 session 的題序會亂** —— `exam.ts` 兩處 `ORDER BY q.number ASC`,單年沒事,跨年題號重複。見 ①。
- **模擬考不寫 `review_progress`** —— `exam.ts` 只動 `exam_answers`,所以複習統計看不到模擬考的作答。見 ②(選擇在讀取端合併,不改寫入語意)。
- **FSRS 新卡沒有每日上限** —— `review.ts` 的 `fc.question_id IS NULL` 無上限。見 ⑦。

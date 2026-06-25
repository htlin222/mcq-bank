# 詳解講義 — 頁面規格與內容指引

每題一份投影片，固定骨架；Topic Review 可依內容多寡擴成數頁。
總頁數記為 TOTAL（典型 7）。footer 標「第 N / TOTAL 頁」。

## 頁面結構

| 頁 | 標題 | 內容 |
|---|---|---|
| 1 | 題目 | 題幹 + 選項 A–E（**不洩答案**）；底部 `meta` 條：範疇／題型／關聯考點／難度 |
| 2 | 解題思路 | 題型辨識 + 心法 → 逐項真偽表（`table.tf`，欄：選項/敘述/關鍵判準/判定）→ 考點框 → `答案 X` → 收尾金句 |
| 3 | 這題想考什麼？ | 雙欄：本題核心（核心概念+三大必懂+命題慣性）／延伸常考（同主題易出）→ 「換句話問」變化題型考點框 → 一句話帶走 |
| 4..TOTAL-1 | Topic Review ①②③… | 高頻 board review：雙欄對照、比較表、必背數字卡、灰階 figure。每頁聚焦一個子題 |
| TOTAL | Summary & References | 雙欄：一頁帶走（條列重點）／參考文獻；再加「自我檢測口袋題」Q&A |

## 設計規則（硬性）

- **純黑白**：只用黑(#000)/白(#fff)/灰(#222/#333)。無彩色、無漸層、無陰影、無圓角卡片(除選項字母圓圈)。
- **16:9**：`@page 13.333in × 7.5in`（PowerPoint 寬螢幕）。一個 `.slide` = 一頁。
- **簡報友善**：serif 標題(Source Serif/Georgia) + sans 內文；短句、bullet、巢狀清單；一句一概念。
- **塞滿、勿留白**：每頁內容填到約 3/4 以上。空時加：考點框、必背數字、比較表、延伸常考、自我檢測、概念地圖。寧可多放高頻重點，也不要大片空白。
- **figure**：來源多為彩色 → 一律 `filter:grayscale(1)`（模板 `.fig img` 已內建）。圖放右側窄欄，左側放文字。
- **字級**：維持模板既定大小（內文 14.5px、選項 14px、表格 13.5px）。要更滿時是「加內容」，不是縮小字。

## 內容來源與 OpenEvidence

1. `raw/question.json`：題幹、選項、答案、tags、`explanation_md`（基礎詳解）。
2. `raw/enrich.json`：`content_json`（共筆詳解，已整理）、`oe_article_id`、`figures`。**這份本身就是先前用 OE 整理的**，是 Topic Review 的主要素材。
3. **即時 OpenEvidence 補強（建議）**：用 MCP 工具 `oe_ask` 針對該題主題問一則「high-yield board review」，把回覆濃縮成 Topic Review 的條列與必背數字。
   - 連線前提：OE relay 與瀏覽器擴充功能須在**同一埠**。本機 MCP 設 `OE_MCP_RELAY_PORT=8780`，故擴充功能也要建置/重載成 8780。
   - 失敗排查：比對 `curl 127.0.0.1:8780/health` 與 `:8787/health` 的 `connected` 欄位；不一致代表擴充功能沒重載到 8780（見專案記憶 port-8787-collision）。
   - OE 連不上時：**直接用 enrich.json + explanation_md + 既有醫學知識**完成，不要卡住；在末頁註明資料來源。

## 逐字稿（逐字稿.txt）

對應每頁一段口語講稿，給講者照唸。風格：口語、短句、把投影片重點講成完整句子，不照抄條列。每段以「【第 N 頁 — 標題】」起頭。

## 產物與路徑

```
slides/{YEAR}/{NNN}/
├── raw/              extract_question.py 產生：question.json, enrich.json, figure-*.jpg
├── slide.html        複製 assets/template.html 後填內容
├── slide.pdf         render_pdf.py 產生
└── 逐字稿.txt        講者口稿
```

完整成品範例：`slides/114/001/`。

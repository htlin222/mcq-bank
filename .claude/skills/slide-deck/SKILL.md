---
name: slide-deck
description: 為 hema-2026 考古題產生「詳解講義」投影片(黑白極簡 16:9 PDF + HTML + 逐字稿)，每題固定頁面：題目 → 解題思路 → 這題想考什麼 → Topic Review(多頁) → 重點總整理。當使用者要把某題(如 114-001)或某批題目做成詳解講義、slide、簡報、board-review handout 時使用。產物輸出到 slides/{YEAR}/{NNN}/{raw,slide.html,slide.pdf,逐字稿.txt}。
---

# 詳解講義投影片產生器

把一題考古題做成 board-exam 風格的詳解講義：黑白極簡、16:9、簡報友善、bullet 短句、高頻重點塞滿。

腳本與素材用**絕對路徑**叫用。先把本技能目錄(指令開頭的 **Base directory for this skill**)設進變數：

    SKILL="<貼上 Base directory for this skill>"

開工前先讀 `references/page-spec.md`(頁面結構+設計規則+OE 指引)；撰寫 HTML 時對照 `references/components.md`(CSS class 用法)。

## 每題流程

對每個題號(例 `114-001`，也接受 `114-1`)依序做：

### 1. 抽原始資料
    python3 "$SKILL/scripts/extract_question.py" 114-001
- 從 `years/{YEAR}/batches/` + `years/{YEAR}/enrich/` 抽出該題，寫入 `slides/{YEAR}/{NNN}/raw/`(含 figures，已下載供灰階呈現)。
- stdout 印出題幹/選項/答案/tags/共筆詳解/oe_article_id/圖清單 —— 這是撰寫講義的素材。

### 2.（建議）即時 OpenEvidence 補強
用 MCP 工具 `oe_ask` 針對該題主題問一則 high-yield board review，濃縮進 Topic Review。
- 連不上時**不要卡住**：改用 enrich.json + explanation_md + 既有知識完成。排查與埠號設定見 `references/page-spec.md`「OpenEvidence」段。

### 3. 撰寫 slide.html
複製模板再填內容：
    command cp "$SKILL/assets/template.html" slides/{YEAR}/{NNN}/slide.html
- 依 `references/page-spec.md` 的頁面結構與**設計規則**填每一頁；class 用法見 `references/components.md`。
- **填滿勿留白**：每頁約 3/4 以上；空時加考點框/必背數字/比較表/延伸常考/自我檢測。字級維持模板大小，要更滿是「加內容」不是縮字。
- figure 走 `raw/figure-*`，模板已自動灰階。完整成品可參考 `slides/114/001/slide.html`。

### 4. 轉 PDF
    python3 "$SKILL/scripts/render_pdf.py" slides/{YEAR}/{NNN}/slide.html
- 用 headless Chrome 輸出同目錄 `slide.pdf`。產生後**讀 PDF 檢查每頁版面**(是否溢出、是否太空)，必要時調整 HTML 再轉一次。

### 5. 寫逐字稿
`slides/{YEAR}/{NNN}/逐字稿.txt`：對應每頁一段口語講稿，風格見 `references/page-spec.md`。

## 產物
```
slides/{YEAR}/{NNN}/
├── raw/{question.json, enrich.json, figure-*.jpg}
├── slide.html
├── slide.pdf
└── 逐字稿.txt
```

## 批次（多題）
逐題重複上述流程；題目彼此獨立，量大時可平行(每題一個子代理/工作流分支)，但每題仍須「轉 PDF → 讀檔檢查版面」。先做一題給使用者確認風格，再全量。

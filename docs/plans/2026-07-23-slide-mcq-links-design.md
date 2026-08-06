# 講義投影片 → 歷屆考題關聯（reader 右欄「歷屆考題」面板）

日期：2026-07-23
狀態：設計定案，待實作

## 1. 目標與範圍

在講義閱讀器 `/lectures/:slug`（`LectureReader` → `LecturePanel`）右欄，於既有
「筆記 / 標註」旁新增第三個 tab 「**歷屆考題**」，顯示**當前投影片這一頁涵蓋到
的歷屆 MCQ 考古題**。使用者點卡片 → 看 MCQ preview dialog → 決定是否「去複習」
（導向單題頁 `/q/:id`）看詳解。

範圍界定（YAGNI）：

- **只針對 `kind='lecture'` 的複習班講義**。Wintrobe 教科書章節（`kind='textbook'`）
  在 reader 是唯讀、無右欄面板，不在此功能內。
- **逐頁為主**：右欄只顯示「當前頁 `currentPage`」對應的考題，隨翻頁更新。不做
  「本講義全部相關考題」次區塊（可日後再加，資料表已足以支撐）。
- **關聯品質全部在離線本機算好**；runtime 只做一次 D1 indexed lookup。

## 2. 核心決策

| 決策 | 選擇 | 理由 |
|------|------|------|
| 匹配算在哪 | **離線本機一次性預算**，存 join 表 | runtime 零 Workers AI / 零 Vectorize query，穩在 free tier；昂貴比對只付一次 |
| 匹配演算法 | **語意召回 + LLM 逐題判定** | 召回全、精準高；本機可徹底跑，不受 10K neurons/day 限制 |
| 面板範圍 | **逐頁** | 對應使用者「這一頁投影片考過的題」語意，UI 最簡潔 |
| 去複習目標 | `/q/:id` | 既有單題深連結（`App.tsx` `<Route path="/q/:id">`） |

## 3. 資料模型

新增 migration `00XX_lecture_page_questions.sql`：

```sql
-- 一張投影片頁涵蓋到的歷屆 MCQ。離線 pipeline（scripts/build-slide-mcq-links.ts）
-- 產出，reader 右欄「歷屆考題」面板讀取。page 為 1-based PDF 頁碼，對齊
-- lecture_pages / lecture_notes 的頁碼慣例。
CREATE TABLE lecture_page_questions (
  slug        TEXT    NOT NULL,             -- lecture_docs.slug（kind='lecture'）
  page        INTEGER NOT NULL,             -- 1-based PDF page（= currentPage + 1）
  question_id TEXT    NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  score       REAL    NOT NULL,             -- LLM relevance 0..1，面板內排序用
  rank        INTEGER NOT NULL,             -- 頁內名次（0 = 最相關）
  method      TEXT    NOT NULL,             -- 'llm' | 'fts' | 'tag'（產出來源，除錯用）
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (slug, page, question_id)
);
CREATE INDEX idx_lpq_slug_page ON lecture_page_questions(slug, page);
```

- 對 `questions(id)` 用 `ON DELETE CASCADE`：題目刪除時關聯自動消失。
- 沒有反向依賴 `lecture_docs`（外鍵略），因為刪講義本就會清 `lecture_pages`，
  重建 pipeline 會覆寫；保持表獨立、可整批 delete-then-insert 重建。

## 4. 離線 pipeline（`scripts/build-slide-mcq-links.ts`）

本機一次性執行（可重跑）。比照 `scripts/backfill-vectors.ts` 的「一次性 remote
write」慣例：算完寫**本機 D1**，驗證後再 `--remote` 推上去。

逐 `slug`（kind='lecture'）、逐 `page` 處理：

1. **輸入**：`lecture_pages(slug, page, text)`。跳過文字過短（如 < 20 字）的
   標題頁 / 過場頁——這些不會有對應考題，直接產空集合。
2. **候選召回（union，寧濫勿缺）**：
   - **語意**：`text` → embedding（`@cf/baai/bge-base-en-v1.5`，與 `/q/:id/similar`
     同模型）→ 對 questions 向量取 cosine top-K（K≈30）。
     - questions 端向量：優先重用 `backfill-vectors.ts` 已 embed 進 Vectorize 的
       題庫；或離線 pipeline 自行 embed 全題庫並在記憶體內算 cosine（self-contained，
       不依賴 Vectorize 已回填）。**採自行 embed 的自足路線**，避免耦合 VEC binding。
   - **詞彙**：抽 `text` 關鍵字 → `questions_fts` MATCH（OR）取 bm25 top-K。
   - **標籤**：`text` 命中的 `question_tags.tag` → 取共享該標籤的題。
   - 三源去重合併成候選集（每頁通常數十題）。
3. **LLM 逐題判定（精準閘門）**：對每個候選，給 LLM「這張投影片文字 + 這題題幹/
   選項」，問「**這題是否在測驗這張投影片教的內容？**」回 `{relevant: bool,
   score: 0..1}`。只保留 `relevant=true`。
   - 本機跑，模型可用較強者（不受 Workers AI free tier 限制）。
   - temperature 0，結構化 JSON 輸出。
4. **收斂**：通過者依 score 排序，每頁取 **top 6**，寫 `lecture_page_questions`
   （delete-then-insert 該 (slug) 整批，冪等可重跑）。

重跑時機：新講義匯入、題庫增修後，手動或掛夜間 cron（`crons` 已存在）重建受影響
的 slug。

> 已知限制：bge-base-en 對中文題幹召回可能偏弱；用 FTS + tag union 補召回、LLM
> 判定把精準度拉回。離線本機不受限，若召回不足可換多語 embedder，表結構不變。

## 5. Runtime

### 後端 `GET /api/lectures/:slug/questions?page=N`（`worker/routes/lectures.ts`）

```
SELECT q.id, q.year, q."group", q.stem, q.options_json, q.answer,
       lpq.score, lpq.rank,
       (SELECT GROUP_CONCAT(tag, ' ') FROM question_tags t WHERE t.question_id = q.id) AS tags
FROM lecture_page_questions lpq
JOIN questions q ON q.id = lpq.question_id
WHERE lpq.slug = ?1 AND lpq.page = ?2
ORDER BY lpq.rank
```

- `page` 為 1-based（前端傳 `currentPage + 1`）。
- 表未建 / 未回填 → 回 `[]`（面板顯示空狀態），**不報錯**。
- 回傳含 `answer` 與 `options_json`：preview dialog 需要即時揭曉答案，不再多一趟。

前端 wrapper 加入 `lectureApi.ts`：`listPageQuestions(slug, page)`。

### 前端 `LecturePanel`（`components/lecture/LecturePanel.tsx`）

- `type Tab` union 加 `"questions"`；tab 列加第三顆 `<TabBtn>`「歷屆考題」+ 數量
  `<Count>`（複用既有 helper）。
- 新 `QuestionsTab`：依 `currentPage`（→ `pdfPage`）呼叫 API；翻頁即重載（debounce
  或直接依賴 `pdfPage` 變化的 effect）。
- 卡片：`114-037` id chip、年份/組別 badge、題幹前段（~60 字）、tags。
- 點卡片 → **preview dialog**：完整題幹 + 選項；「顯示答案」展開正解 + 詳解摘要；
  主行動「**去複習**」→ `navigate('/q/' + id)`。
- 空狀態：「這張投影片沒有對應的歷屆考題。」

## 6. 資料流

```
翻頁 → currentPage(0-based) → pdfPage = currentPage + 1
     → GET /api/lectures/:slug/questions?page=pdfPage
     → lecture_page_questions ⋈ questions  (indexed lookup, 亞毫秒)
     → 卡片列表(依 rank)
點卡片 → preview dialog(題幹/選項/答案/詳解摘要)
       → 「去複習」→ navigate(/q/:id)
```

## 7. free tier 稽核

- **Runtime**：僅一次 `(slug,page)` indexed D1 lookup + 一次 JOIN。零 Workers AI、
  零 Vectorize、零外呼。
- **離線**：embedding 與 LLM 判定全在本機一次性，不佔 production 神經元額度。
- 新增一張小 join 表（每頁 ≤6 列），D1 容量無虞。

## 8. 邊界與失效模式

| 情況 | 行為 |
|------|------|
| 當前頁無對應題 | 空 tab（正常，多數過場頁如此） |
| 表未建 / pipeline 未跑 | API 回 `[]`，面板空狀態，其餘 reader 功能不受影響 |
| 題目已刪除 | `ON DELETE CASCADE` + JOIN 自然濾掉 |
| textbook 章節（kind='textbook'）| 無右欄面板，功能不觸及 |
| 講義重匯入 | 重跑 pipeline（該 slug delete-then-insert）覆寫 |

## 9. 實作切分（single-commit 粒度）

1. migration：`lecture_page_questions` 表 + index。
2. 離線 pipeline `scripts/build-slide-mcq-links.ts`（召回 + LLM 判定 + 寫表）。
3. 後端 `GET /api/lectures/:slug/questions` + `lectureApi.ts` wrapper。
4. 前端 `LecturePanel` 第三 tab + `QuestionsTab` + preview dialog。
5. 本機跑 pipeline → 驗證 → `--remote` 回填 → 部署。

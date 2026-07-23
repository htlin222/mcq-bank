# 設計 — 教科書引用「選字問 Wintrobe」(Textbook Citations)

日期:2026-07-23
分支:`claude/textbook-integration-feasibility-djmev6`
狀態:**設計提案(feasibility 完成,待審)**

## 目標

一份 ~100 MB 的英文血液學教科書(如 Wintrobe / Williams / Hoffman)整合進系統。
核心互動:**在 App 任何地方選取一段文字,跳出一個 popup「📖 Wintrobe 怎麼說?」,
點擊後直接搜尋並跳到教科書最相關的那一頁**(高亮命中段落),再讓使用者回饋
「這頁符合嗎」,回饋反哺排序。

**全部落在 Cloudflare 免費層,零額外服務。**

## 為什麼工程量比想像小:八成骨架已存在

盤點現況(見 `docs/plans/2026-05-30-review-lectures-design.md` 已實作):

| 這個功能需要的 | 現況 | 位置 |
|---|---|---|
| 大 PDF 線上閱讀、Range 串流、跳頁 | ✅ EmbedPDF + `GET /pdf/:key`(Range/206) | `worker/routes/pdf.ts`、`EmbedPDFViewer.tsx` |
| PDF 逐頁文字 + FTS5 | ✅ `lecture_pages` + `lecture_pages_fts` | `migrations/0016` |
| **「選字 → BM25 搜到最相關頁 + snippet」端點** | ✅ **已存在**(`scope=pdf`,`bm25()` 排序,`snippet()`) | `worker/routes/lectures.ts` 搜尋 handler |
| Reader `?page=N` deep-link | ✅ 已支援,註解明寫「used by lecture search」 | `LectureReader.tsx:44-59, 172+` |
| 選字 popup 樣式 | ✅ `SelectionPopup`(螢光/AI/OE/複製筆記) | `frontend/src/components/lecture/SelectionPopup.tsx` |
| 命中段落高亮 | ✅ `HighlightedSnippet` | `frontend/src/components/lecture/HighlightedSnippet.tsx` |
| 「有幫助」投票冪等骨架 | ✅ `helpful_votes`(一人一票、ON CONFLICT) | `migrations/0024` |
| FTS + Vectorize + tag 三路合併範式 | ✅ `mergeSimilar()` | `worker/lib/similar.ts` |
| 夜間 cron | ✅ `scheduled()`(目前 roster sync + relink drain) | `worker/index.ts` |

**真正要新增的只有兩塊:**
1. 把教科書當一份 `lecture_docs`(kind=`textbook`)匯入 → 頁文字自動進 FTS。
2. **一個 app-wide 的選字 popup**,呼叫(泛化過的)頁面搜尋端點,開 reader 到 `?page=N`。

## 非目標 (v1)

- ❌ 逐題預先算好 (question_id → page) 的固定映射。觸發來源是**任意選取文字**
  (題幹/詳解/留言/筆記/聊天),查詢本質是**執行期即時搜尋**,不是離線批次。
- ❌ Vectorize 語意層(列為 Phase 2,由回饋數據決定要不要做,見下)。
- ❌ 教科書標註/共筆(它是**唯讀參考書**,不是講義;不給 default notes、不做 annotation)。
- ❌ 公開 R2 bucket(維持 Zero Trust,一律走 `/pdf` proxy)。

---

## 1. 匯入教科書(沿用 lecture 管線)

### 1a. Schema:給 `lecture_docs` 加 `kind`

```sql
-- migration 00XX_textbook_kind.sql (動手前 `ls migrations | sort | tail -1` 取真號)
ALTER TABLE lecture_docs ADD COLUMN kind TEXT NOT NULL DEFAULT 'lecture';
-- kind ∈ {'lecture','textbook'};講義索引頁 WHERE kind='lecture' 過濾,
-- 參考書不出現在「複習班講義」grid,由選字 popup / 專屬入口進入。
```

`lecture_pages` / `lecture_pages_fts` **不動** —— 教科書逐頁文字直接沿用,
FTS 觸發器自動 fan-out。這是重用既有 schema 的關鍵。

### 1b. 匯入前置:拆章節冊(見 §1d,EmbedPDF 一律整份下載)

因 EmbedPDF 目前不發 range 請求(§1d 查證),100 MB 單檔會整份下載,故
匯入前**按章節拆冊**、每冊 `qpdf --linearize`(或改走 §1d 路線 2 的 pdf.js)。
逐頁文字抽取沿用 `scripts/import-lectures.ts` / `backfill-lecture-pages.ts`
(pdfjs-dist 逐頁 `getTextContent`)。

> ⚠️ 前提:PDF 必須有**文字層**。若拿到的是掃描影像 PDF,需先 OCR
> (`ocrmypdf`)才能建索引 —— 這是額外前置步驟,匯入前先抽 3 頁 `pdftotext`
> 驗證有無文字層。

### 1c. 免費額度(匯入)

- R2:100 MB / 10 GB。✅
- D1:100 MB PDF 抽文字約 5–30 MB / 5 GB。✅ FTS5 吃得下。
- **零 Workers AI、零 Vectorize**(Phase 1 匯入純文字抽取)。

### 1d. 大檔載入策略:EmbedPDF 一律整份下載 → 教科書**必須拆冊**

「不要一次載入 100 MB」拆成兩個層次:

- **層次 A — 渲染虛擬化(已具備):** `EmbedPDFViewer` 已註冊 `ScrollPlugin`
  + `TilingPlugin`,只 rasterize 視窗附近幾頁,不會把 2000 頁全畫成 canvas。
  講義與教科書都已享有,與檔案大小無關。
- **層次 B — 網路下載(已查證,結論確定):** `worker/routes/pdf.ts` 的
  Range/`206` 已就緒,**但 EmbedPDF 目前不發 range 請求**。官方文件明載:

  > *"Currently, this function **always** downloads the entire PDF file."*
  > `mode:'range-request'` *"is reserved for future use. Currently, only the
  > 'full-fetch' behavior is implemented regardless of the selected mode."*
  > — [EmbedPDF · Open Document from URL](https://www.embedpdf.com/docs/engines/document-lifecycle/open-document-url)

  → 100 MB 單檔在 EmbedPDF **會實打實抓 100 MB**。原本「DevTools 驗 206」
  的前置檢查**已無必要**(結論就是整份下載)。

**兩條解法(擇一):**

**路線 1(推薦)— 拆章節冊 + 續用 EmbedPDF:**

- **按章節拆**(讀 PDF 內建 outline/TOC 在章界切,用 `mutool` / `pdfcpu` /
  `pdf-lib`),非固定頁數。100 MB / ~2000 頁 → 20–40 冊、各 3–8 MB;
  嫌多可粗切 ~10 part。每冊 `qpdf --linearize`。
- 每冊一列 `lecture_docs`,`kind='textbook'`,命名慣例 `wintrobe-ch03`,
  title「Wintrobe · Ch3 CLL」。離線一次性,匯入迴圈把各冊當獨立 doc。
- 每次開一冊 3–8 MB,首開後被瀏覽器快取,再開瞬間。續用既有 viewer /
  SelectionPopup / 截圖 / `?page=N` 全部零改。
- **拆檔不搞碎任何功能:**
  1. **頁碼**:每冊 page 從 1 重數;citation 存 `(slug, local_page)`,
     FTS 的 `(slug, page)` 鍵天然對上,跳頁 = 該冊本地頁。零額外邏輯。
  2. **搜尋不切碎**:`lecture_pages_fts` 同一張表,lookup `WHERE slug IN
     (kind='textbook')` 跨所有冊一起 `bm25()` 排序,回最佳 `(slug, page)`。
  3. **印刷頁碼**(書上「p.1423」)≠ PDF 內頁 index:如需顯示書本頁碼,
     每冊存 `page_label_offset`(選配)。

**路線 2(替代)— 單檔 + pdf.js 唯讀閱讀器:**

- pdf.js **原生支援 HTTP range / byte-serving**,配上你已就緒的 `/pdf`
  Range route,能真正只抓視窗前後幾頁,**單檔 100 MB 不用拆**。
- 代價:教科書多一套 PDF 引擎(pdf.js 與 pdfium 並存)。但教科書**唯讀、
  不需標註**,pdf.js 的 render + scroll + 跳頁 + snippet 高亮已足夠,選字
  lookup 本來就在 app-wide popup(§3)不依賴 viewer 引擎。
- 適合「打死不拆單檔、要真串流」的取捨。

**7 份講義**單份 ~10 MB,整份下載也秒開,**不需動**。

---

## 2. 檢索:「細粒度命中、頁面交付」(small-to-big)

### 研究定論(為什麼這樣切最準)

- **考試型 / 事實型查詢偏好小 chunk**:準確度約在 128 token 觸頂,chunk 越大
  越糊([chunking 研究](https://www.firecrawl.dev/blog/best-chunking-strategies-rag))。
  本功能的查詢正是短、term-rich 的事實選取。
- **但「頁面級」交付最穩健**:NVIDIA 基準中 page-level 檢索 0.648 準確度、
  跨文件型別變異最低;而「跳到那一頁」本來就是我們要的交付單位。

→ **把「檢索單位」與「交付單位」拆開**(業界 small-to-big / parent-page):

1. **檢索用段落級 passage**(~128–256 token)建一張細粒度 FTS,每列標
   `(slug, page)`。細粒度 → 事實查詢準度;**FTS5 無向量數上限 → 免費、無限段落**。
2. **交付用頁面**:最佳 passage → 回它的 `page` 去跳。

```sql
-- migration:教科書段落級檢索表(逐頁文字仍存 lecture_pages 供 reader/回填)
CREATE TABLE textbook_passages (
  slug TEXT NOT NULL, page INTEGER NOT NULL, ord INTEGER NOT NULL, text TEXT NOT NULL,
  PRIMARY KEY (slug, page, ord)
);
CREATE VIRTUAL TABLE textbook_passages_fts USING fts5(
  slug UNINDEXED, page UNINDEXED, text,
  tokenize = 'unicode61 remove_diacritics 2'          -- 同 0016 慣例
);
-- 觸發器同步(比照 0016 的 lecture_pages_ai/ad/au)
```

> 亦可先偷懶:v0 直接用既有 `lecture_pages_fts`(逐頁)驗證流程,量測後再引入
> 段落級表換取準度。逐頁是「大 chunk」,對敘述段召回較差,故正式版建議段落級。

### 端點

```
POST /api/textbook/lookup   { text, limit? }
 → { hits: [{ slug, page, snippet, score }] }
```

- 伺服器把選取文字 `text` 正規化成 FTS query(沿用現有 `ftsQuery` 清洗;
  長選取先用 `note-terms.ts` 受控詞表抽藥名/基因/疾病做加權,避免雜訊)。
  對 `textbook_passages_fts` `MATCH` → `ORDER BY bm25(...)` → 取 top-N passage,
  收斂到 distinct `(slug, page)`,`snippet()` 回命中片段。
- **Phase 1 = 純 FTS,零神經元、零 Vectorize、亞毫秒級。**
- 身分一律 `c.var.email`;端點只讀不寫。

### 為什麼英文教科書仍建議 FTS 先行(而非一上來就上向量)

- 本領域選取多為 term-rich(`venetoclax` / `TP53` / `Richter transformation`),
  BM25 對這類**精確識別詞**命中極強,dense 反而常漏。
- **混合檢索**證據雖硬(BM25+dense **91% recall@10** vs dense 78% / BM25 65%,
  [hybrid 2026](https://www.digitalapplied.com/blog/hybrid-search-bm25-vector-reranking-reference-2026)),
  但有反直覺 caveat:BM25+embedding 主要幫**小模型**,對**強 embedding
  (如 Stella)反而可能扣分** —— bge-m3 偏強,混合邊際增益未必如帳面。
- 結論:**先上純細粒度 FTS,用 §4 回饋量測**;真的漏召回敘述段再進 §5。

---

## 3. 全站選字 popup(唯一較大的新前端件)

目前 `SelectionPopup` 只活在 `LectureReader`。要「任何地方選字都能問」,需一個
**app-wide 選取監聽 + portal popup**,掛在根部(比照 `ChatProvider` 全站掛載)。

- `frontend/src/lib/useTextSelection.ts`:全域 `selectionchange`/`mouseup`
  監聽,節流,取 `window.getSelection()` 純文字 + 錨定 rect;
  **護欄**:選取長度 `>= 3 且 <= 400` 字才顯示、忽略在輸入框/編輯器內的選取
  (避免打字時亂跳)、單一不擾動的小徽章(不是四顆大按鈕),點它才展開。
- `frontend/src/components/TextbookLookupPopup.tsx`:
  - 動作「📖 Wintrobe 怎麼說?」→ `POST /api/textbook/lookup`。
  - 結果:inline 顯示 top-1 snippet(`HighlightedSnippet`)+「開啟該頁」→
    導到 `/lectures/<slug>?page=N`(deep-link 已支援),或 top-3 頁清單。
  - popup 內嵌 §4 的回饋鈕。
- 掛載點:`App.tsx` 根附近(全站生效);行動版用 bottom-sheet 呈現。
- **與既有 lecture `SelectionPopup` 的關係**:抽共用的「popup 錨定/dismiss」
  邏輯,教科書 lookup 動作可反向加進 lecture reader 的 popup(讀講義時也能
  「問教科書」),但 v1 以全站件為主,不強制重構既有件。

### 3a. 呈現:兩段式 + 抽屜(不是 dialog、不是整頁跳走)

情境是「讀題/讀詳解讀到一半」選字去問,故**不能蓋掉原本的閱讀脈絡**。

**兩段式,把「便宜的預覽」與「載入 PDF」分開:**
1. popup 先顯示 FTS 的 `snippet()` 命中片段 —— **完全不碰 PDF、不啟動
   pdfium、零載入**,瞬間出結果。沒興趣的選取永遠不會載入大檔。
2. 使用者點「開啟教科書該頁」才 boot pdfium + 抓該頁。

**呈現用側邊抽屜 / bottom-sheet**,掛同一個 `EmbedPDFViewer` 跳到目標頁:

- 桌機右側滑出、手機從下方拉起;底下那題仍在,關掉即回原位。
- 抽屜內可翻前後頁(真正的 PDF 瀏覽器體驗),角落再給「在完整閱讀器開啟」
  → `/lectures/:slug?page=N`(deep-link 已支援),供久讀。
- **不用小 dialog**(翻頁太擠)、**不用整頁路由**(蓋掉原題、關掉回不去)。

---

## 4. 回饋機制「這頁符合嗎」(比照 helpful_votes)

```sql
-- migration 00YY_citation_feedback.sql
CREATE TABLE citation_feedback (
  user_email  TEXT    NOT NULL REFERENCES users(email),
  query_key   TEXT    NOT NULL,   -- 正規化後的查詢鍵(見下)
  slug        TEXT    NOT NULL,
  page        INTEGER NOT NULL,
  verdict     TEXT    NOT NULL,   -- 'helpful' | 'wrong_page' | 'irrelevant'
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (user_email, query_key, slug, page)
);
CREATE INDEX idx_citfb_page ON citation_feedback(slug, page, verdict);
```

**開放式查詢的回饋比固定題目難** —— 任意選取文字近乎無限,用原文當鍵太稀疏。
對策:`query_key` = 從選取抽出的**主導術語**(重用 `note-terms.ts` 的
受控詞表比對:命中的疾病/藥物 tag 排序後取前幾個組成 key)。這讓
「不同人選到同一疾病段落」能聚合成同一 key。

**閉環(Phase 2,夜間 cron):**
- 聚合 `citation_feedback` → 每個 (query_key, page) 的淨分(helpful − negative)。
- lookup 時把 BM25 分數 + 回饋淨分做**輕量 re-rank**(負評多的頁降權/隱藏)。
- 純 SQL 排序,**零 AI**。這就是你要的「收集回饋來優化索引」。

---

## 5. 混合檢索 + reranking(Phase 2/3,選配,由回饋觸發)

只有當 §4 回饋顯示細粒度 FTS 漏召回敘述性段落時才做。

**Phase 2 — 加 dense 第二路(逐頁,fits 免費上限):**

- **逐頁 embedding**(頁面級,非段落級 —— 這裡刻意用大 chunk **控制向量數**;
  細粒度留給零成本的 FTS)。Wintrobe ~2,000 頁 → ~2,000 向量;bge-m3 1024 維
  → 2.05 M 維 < **免費 500 萬儲存維度**。✅([Vectorize pricing](https://developers.cloudflare.com/vectorize/platform/pricing/))
- 一次性回填 ~2,000 embed,免費 **10,000 neurons/日 ≈ 12,500 embed/日**,
  一天做完。([Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/))
- 查詢期:選取 embed(1 call)→ Vectorize cosine 取頁 → 與細粒度 FTS 的頁
  用 `mergeSimilar()` 範式合併(vec + fts)。你**已在 production 用 Vectorize
  跑相似題**,查詢範式相同。查詢維度免費 30 M/月;identical 選取走 KV 快取。
- 混合證據:BM25+dense **91% recall@10** vs dense 78% / BM25 65%。

**Phase 3 — reranking(只有「對的頁常排第 2–3 名」才加):**

- Cloudflare `@cf/baai/bge-reranker-base` = **283 neurons / M input token**
  ([bge-reranker-base](https://developers.cloudflare.com/workers-ai/models/bge-reranker-base/));
  一次查詢重排幾個候選 × 幾百 token ≈ 免費額度的零頭。
- **但每次 +100–300 ms 延遲**,對即時 popup 不划算 → v1/v2 不做。要做的話
  rerank **混合後**的候選(研究顯示對混合候選增益最大),不是對單路。
- **若 Phase 1 純 FTS 回饋良好,§5 整段可永遠不做。**

---

## 6. 免費額度總結(2026 現況,已查證)

| 資源 | 免費額度 | 本功能 Phase 1 | Phase 2(選配) |
|---|---|---|---|
| Workers AI neurons | 10,000/日 | **0** | 一次性 ~2,000 embed;查詢期每次 1 |
| Vectorize 儲存維度 | 5 M | **0** | ~2 M(逐頁 1024 維) |
| Vectorize 查詢維度 | 30 M/月 | **0** | 每次 lookup 1 向量,KV 快取 |
| R2 | 10 GB | 100 MB | — |
| D1 儲存 | 5 GB | 抽文字 5–30 MB | 派生表數 KB |
| Worker CPU / cron | 已有 `scheduled()` | 加一個聚合任務 | 同 |

→ **Phase 1 完全零額外開銷、零 AI。** Phase 2 也穩在免費層內。

---

## 7. 分階段落地

1. **Phase 1(純 FTS,零 AI)**:
   1. 教科書**拆章節冊**(§1d 路線 1,已定論 EmbedPDF 整份下載)+ `kind`
      migration + 逐頁文字 + **段落級 `textbook_passages_fts`**(§2)。
   2. `POST /api/textbook/lookup`(細粒度 BM25 → 收斂到頁)。
   3. 全站選字 popup(§3)+ 兩段式抽屜呈現(§3a)→ 跳頁 + snippet 高亮。

   **這一階段就滿足核心需求。**
2. **Phase 2**:`citation_feedback` 表 + popup 回饋鈕 + 夜間聚合 re-rank。
3. **Phase 3(選配)**:Vectorize 逐頁語意層,只在回饋顯示 FTS 召回不足時補位。

---

## 8. 驗證

- Worker:`/pdf` Range → 206;`/api/textbook/lookup` 對已知術語回正確頁;
  身分邊界(選字 lookup 只讀、不洩他人資料);線性化後首開 Range 正常。
- 前端:`tsc -b` clean;EmbedPDF 仍是 lazy chunk(不進主包);
  全站選字 popup 不在輸入框/編輯器內誤觸;手動 smoke —— 在題幹選
  「Richter transformation」→ popup → 跳到教科書該頁 + 高亮 → 回饋鈕寫入。
- `.gitignore`:教科書 PDF 不進 git / Pages bundle(只在 R2),同講義慣例。

## 已知取捨

- **回饋新鮮度**:re-rank 快取夜間更新,當日新回饋隔天生效(比照 note-links
  的派生快取語意,偏保守可接受)。
- **開放式查詢的回饋稀疏**:靠 `query_key` 用受控詞表聚合緩解;完全沒命中
  詞表的自由選取,回饋只影響該精確查詢(可接受)。
- **掃描影像教科書**:需 OCR 前置,匯入前以 `pdftotext` 抽樣驗證文字層。

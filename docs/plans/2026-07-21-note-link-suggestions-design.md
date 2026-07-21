# 筆記關聯連結建議(Note Link Suggestions)設計

日期:2026-07-21
狀態:範圍已與 owner 確認,待實作

## 目標

為**已有內容的筆記**動態產生「相關連結」建議:當一則筆記提到某些
關鍵字 / 疾病時,在筆記側欄列出少數幾個高信心的相關去處。核心原則
與「相關題目」一致——**先有一份受控關鍵字詞表,再用關鍵字匹配**,
而不是讓 AI 對每則筆記自由生成連結。

避免連結爆炸是第一守則(業界可讀性甜蜜點:內文連結密度 1–3%)。

## 已確認的決策

| 決策 | 結論 |
|---|---|
| 連結範圍(私人筆記) | 只連到**同一使用者自己**的其他私人筆記(不跨人,守住 `migrations/0009` 的隱私設計) |
| 連結範圍(公開) | 筆記可連到所有公開資源:題目、共筆詳解 |
| 匹配方式 | **受控詞表 + 關鍵字匹配為主**(確定性、可解釋、零 AI 成本),Vectorize 語意層列為未來次要召回 |
| 受控詞表來源 | 直接用既有的 `question_tags`(AML / MDS / ITP … 疾病與主題標籤),已是現成的疾病本體 |
| 關鍵字抽取 | 對筆記純文字做**確定性詞表比對**(零神經元),不強制走 AI;`note_cloze` 已抽好的 terms 可當加分項 |
| 產生時機 | **每日 cron 批次預算**,寫進派生表;執行期只查表 |
| 呈現 | 側欄「🔗 你可能想連結」**建議制**,使用者點選才跳轉;不自動寫入正文 |
| 每則上限 | 最多 5 條建議,低於分數門檻寧可不顯示 |

## 免費方案確認

- **零 AI 成本路徑**:主力是 D1 內的確定性詞表比對 + SQL 排序,執行期
  不呼叫 Workers AI,不吃 10,000 neurons/日 的額度。
- **cron**:已有 `worker/index.ts:123-140` 的 `scheduled` handler(目前
  只跑 roster sync),新增一個夜間任務即可,無新增服務。
- **Vectorize(未來選項)**:免費層 30M 查詢維度 + 5M 儲存維度/月,
  題庫規模綽綽有餘;但 v1 不需要。

## 為何沿用「相關題目」的骨架

現有 `GET /api/questions/:id/similar`(`worker/routes/questions.ts:307-419`,
合併於 `worker/lib/similar.ts`)已是三路混合:Vectorize 語意 + `question_tags`
重疊 + FTS BM25。本功能直接複用其中**零成本、可解釋**的那一路——
`question_tags` 標籤重疊——作為主力,把同一套受控詞表延伸到筆記。

## 資料模型

### 1. 受控詞表 + IDF 權重(派生,夜間重建)

用來讓**罕見詞**(如 Richter transformation)權重高、**常見詞**
(如「血液」)幾乎不產生連結——這是避免過多連結的核心閘門。

```sql
CREATE TABLE keyword_vocab (
  term        TEXT PRIMARY KEY,   -- 來自 DISTINCT question_tags.tag
  df          INTEGER NOT NULL,   -- document frequency:帶此 tag 的題數
  idf         REAL NOT NULL,      -- ln(N_questions / (1 + df))
  updated_at  INTEGER NOT NULL
);
```

- 夜間由 `question_tags` 聚合重建;可另備一份 `stopwords` 常數陣列
  (過泛的詞)在建表時排除。

### 2. 建議快取(派生,夜間增量重算)

筆記以 `(user_email, question_id)` 為鍵(`personal_notes`),故建議表也
以此為前綴。**這是純派生快取**,可隨時由 cron 重算覆寫(比照
`review_progress` 的派生語意)。

```sql
CREATE TABLE note_link_suggestions (
  user_email    TEXT NOT NULL,        -- 這則筆記的擁有者
  question_id   TEXT NOT NULL,        -- 這則筆記(note 的 PK 之一)
  target_kind   TEXT NOT NULL,        -- 'note' | 'question'
  target_id     TEXT NOT NULL,        -- 目標的 question_id
  score         REAL NOT NULL,        -- Σ idf(共享詞)
  shared_terms  TEXT NOT NULL,        -- JSON string[],可解釋「因為都提到 AML」
  computed_at   INTEGER NOT NULL,
  PRIMARY KEY (user_email, question_id, target_kind, target_id),
  FOREIGN KEY (user_email, question_id)
    REFERENCES personal_notes(user_email, question_id) ON DELETE CASCADE
);
CREATE INDEX idx_note_links ON note_link_suggestions(user_email, question_id, score DESC);
```

- `target_kind = 'note'`:目標是**同一 `user_email`** 的另一則筆記
  (私人只連私人、且不跨人)。`target_id` 為那則筆記的 `question_id`。
- `target_kind = 'question'`:公開題目;若該題有共筆詳解,前端一併標示
  「含共筆詳解」(詳解本就掛在題目上,不需另一種 kind)。

> 註:v1 先不做「筆記 → 純詳解」的獨立連結,因為詳解永遠附屬於題目,
> 連到題目即涵蓋。若日後要突顯詳解,加 `target_kind='explanation'` 即可,
> schema 不變。

## 每日 cron(夜間批次)

在既有 `scheduled` handler 內串一個步驟(用 `ctx.waitUntil`),流程:

1. **重建 `keyword_vocab`**:`SELECT tag, COUNT(*) FROM question_tags
   GROUP BY tag`,算 `idf`,排除 stopwords,覆寫。
2. **挑出需重算的筆記**:`personal_notes` 中 `updated_at > 上次 cron 時間`
   者(增量;首次全量)。
3. **對每則筆記**:
   a. 取其 `content_json` → 純文字(重用 `tiptapToMarkdown`,見
      `worker/routes/mcq.ts:4`)。
   b. 對 `keyword_vocab` 做確定性比對,得到命中的受控詞集合 `T`
      (可再與該筆記 `note_cloze.terms_json` 取聯集加強召回)。
   c. **候選題目**:`question_tags` 中帶有 `T` 內任一詞的題目
      (排除筆記自身題目)。
   d. **候選筆記**:**同一 user** 其他筆記,其命中詞集合與 `T` 有交集。
      需要一份 per-user 的「筆記→命中詞」對照(步驟 3b 的產物存成暫表
      或一次算全量)。
   e. 每個候選算 `score = Σ idf(共享詞)`;過門檻者按 score 取
      **top 5**;寫入 `note_link_suggestions`(先刪該筆記舊列再插)。

成本:全確定性 SQL + 字串比對,**零神經元**;20 人 × 1000 題規模,
夜間批次秒級完成,穩落免費額度內。

## 執行期端點

```
GET /api/questions/:id/note/links
```

- 以 `c.var.email` + `:id` 讀 `note_link_suggestions`,join 目標題目
  取顯示用標題(題號 / 年份 / stem 首句)與「是否含詳解」。
- 回傳 `{ links: [{ targetKind, targetId, title, sharedTerms, score }] }`。
- **純查表**,無 AI、無 Vectorize 呼叫。
- 讀取路徑不進 PWA runtime cache(比照 `sw-guards.ts` 對個人化端點的
  處置——這是 per-user 資料)。

## 前端

- 在 `frontend/src/routes/Question.tsx` 的「note」分頁,`<NoteContent>`
  下方加一個側欄區塊「🔗 你可能想連結」。
- 只在有筆記內容且 `links` 非空時顯示;每條列出目標標題 + 命中詞
  chips(「AML」),點擊跳該題;`target_kind='note'` 者標示「你的筆記」。
- **不自動改寫正文**,純建議。

## 避免過多連結的護欄(對應可讀性 1–3%)

1. 每則筆記 **≤ 5 條**。
2. **IDF 加權**:常見詞近乎不貢獻分數;罕見疾病詞才觸發連結。
3. **stopwords**:過泛詞從詞表排除。
4. **分數門檻**:低於門檻顯示「暫無建議」,寧缺勿濫。
5. **建議制**:側欄呈現,人為採納,不污染筆記內容。

## 明確不做(v1)

- ❌ 跨使用者的筆記關聯(違反 `migrations/0009` 隱私設計)。
- ❌ 執行期即時 AI / Vectorize(成本與延遲;改為夜間預算)。
- ❌ 自動把連結寫進筆記正文。

## 未來延伸(reserved)

- Vectorize 語意層作**次要召回**:當受控詞比對命中不足時補位。惟
  私人筆記若要進向量索引,必須 per-user 隔離(metadata filter 或
  獨立 index),否則洩漏讀書模式——沿用 `0009` 的紅線。
- 疾病「主題樞紐頁」(MOC):與其筆記兩兩互連,不如都連向該疾病的
  彙整頁,進一步壓低連結密度。

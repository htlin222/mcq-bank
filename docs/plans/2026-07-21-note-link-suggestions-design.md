# 筆記關聯連結建議(Note Link Suggestions)設計

日期:2026-07-21
狀態:**已實作並在本地 smoke test 通過**(migration 0030)。全確定性 SQL,
零 Workers AI 神經元。

實作對照:
- `migrations/0030_note_links.sql` — keyword_vocab / note_terms /
  note_link_suggestions 三表 + personal_notes.needs_relink
- `worker/lib/note-terms.ts`(純函式,`note-terms.test.ts` 6 案)—
  plainTextFromDoc / extractTerms(受控詞比對) / mergeTopSuggestions(排序+護欄)
- `worker/lib/note-links.ts` — loadVocab / rebuildVocab(IDF) /
  computeNoteSuggestions(單則) / drainRelinkQueue(預算 drain)
- `worker/routes/notes.ts` — 寫入設 needs_relink=1;`GET /:id/note/links`
  (髒則惰性計算) ;DELETE 連帶清 note_terms/suggestions
- `worker/routes/mcq.ts` — mcq skill 寫入路徑同設 needs_relink=1
- `worker/index.ts` `scheduled()` — 夜間 rebuildVocab + drainRelinkQueue
- `frontend/src/routes/Question.tsx` — 筆記分頁「你可能想連結」側欄

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

## 計算模型:寫入=旗標、讀取=惰性、夜間=預算 drain

分三段,把「即時感」與「成本可控」拆開:

1. **寫入端(便宜):** `PUT /:id/note`(web 與 mcq skill 兩條路徑)只把
   `needs_relink=1`。不抽詞、不算候選 —— 就算有人一次倒 500 則也不觸發
   計算,不製造白天尖峰。
2. **讀取端(惰性,單則):** `GET /:id/note/links` 若該筆記 `needs_relink=1`,
   就地 `computeNoteSuggestions()` 一次(抽詞 → note_terms → 兩條候選 SQL →
   合併取 top-5 → 寫 suggestions → 清旗標),再回傳。單則、純 SQL、在 fetch
   handler(CPU 充裕),讓「使用者剛開的那則筆記」建議即時出現。
3. **夜間 cron(批次,有預算):** `scheduled()` →
   `rebuildVocab()`(重建 df/idf)+ `drainRelinkQueue()`:掃 `needs_relink=1`,
   **最舊優先**逐則 `computeNoteSuggestions()`,到 `DRAIN_MAX_NOTES` /
   `DRAIN_MAX_WRITES` 就停,剩下明晚再做。負責:沒人開過的筆記、mcq 批次
   匯入的筆記、以及讓 note→note 在雙方都被算過後串起來。

`computeNoteSuggestions()` 的兩條候選 SQL(見 `worker/lib/note-links.ts`):

- **候選題目**:`question_tags` 帶有本筆記命中詞者,`SUM(COALESCE(v.idf,0.5))`
  排序,`json_group_array(tag)` 帶回共享詞;排除本題。
- **候選筆記**:`note_terms` 中 **`user_email = 本人`** 且詞交集者,排除本則。
  `WHERE nt.user_email = ?` 就是隱私紅線 —— SQL 層保證永遠不跨人。

## 免費方案用量與安全邊際

主力路徑**零 Workers AI 神經元**(10,000/日 完全不碰)。真正的天花板是:

| 資源 | 免費額度/日(00:00 UTC 重置) | 本功能 |
|---|---|---|
| Workers AI 神經元 | 10,000 | 0 |
| D1 寫入列 | 100,000 | 夜間 drain 的預算對象 |
| Worker CPU / 每次 cron | 10 ms | 計算下推 D1,故極省 |

- 每則筆記重算 ≈ 刪+插 note_terms(≤24)+ 刪+插 suggestions(≤5)+ 清旗標
  ≈ 十幾列寫入。`DRAIN_MAX_WRITES = 20,000`(D1 寫入額度 20%)→ 每晚約
  1,500 則上限,替白天 app 永遠留 80% 餘裕。
- **突發防護**:某人半夜生 5,000 則 → 佇列在幾個晚上內、每晚固定配額消化
  (`remaining` 會在 cron log 顯示),不會單晚爆量。
- **CPU**:`*/10 19-21 UTC`(≈台北 03–05 點)多次觸發,每次只吃一小塊,
  且比對/排序都在 D1,Worker 自身 CPU 遠低於 10ms。

## 執行期端點

```
GET /api/questions/:id/note/links → { links: [{ targetKind, targetId,
     year, number, stem, group, sharedTerms }] }
```

- 以 `c.var.email` + `:id` 為界;髒則先惰性計算,再讀 `note_link_suggestions`
  join `questions` 補顯示欄位。
- note-kind 結果額外要求「該目標筆記仍屬本人且存在」(`EXISTS` 子查詢),
  避免刪除後的懸空建議外顯。
- **無 AI、無 Vectorize 呼叫。**

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

## 已知取捨:建議的「新鮮度」

派生快取必然有滯後。因為只有 `needs_relink=1` 的筆記會重算,一則**已算過**
的筆記不會因為「別處新增了相關筆記/題目」而自動刷新 —— 要等它自己被再次
編輯,或夜間 cron 掃到它。具體表現:

- 你寫了筆記 A(算過),稍後才寫下相關的筆記 B →A 要到下次被編輯/夜間
  重算才會出現 →B 的連結。B 自己則是一開就即時看到 →A(前提:A 已算過)。

這是**偏保守**的方向(寧可少連,不亂連),符合「避免過多連結」的目標,可接受。
若要更即時,兩個漸進選項(未實作):

- 寫入端順便把「同一使用者、且與新筆記共享詞」的其他筆記也標 `needs_relink=1`
  (bounded cascade,只在自己的筆記圖內,成本可控)。
- 夜間 drain 排空髒佇列後若預算有餘,輪流重算「最久沒算過」的筆記,吸收
  題庫標籤演進造成的漂移。

## 未來延伸(reserved)

- Vectorize 語意層作**次要召回**:當受控詞比對命中不足時補位。惟
  私人筆記若要進向量索引,必須 per-user 隔離(metadata filter 或
  獨立 index),否則洩漏讀書模式——沿用 `0009` 的紅線。
- 疾病「主題樞紐頁」(MOC):與其筆記兩兩互連,不如都連向該疾病的
  彙整頁,進一步壓低連結密度。

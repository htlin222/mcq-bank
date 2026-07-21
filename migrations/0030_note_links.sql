-- ============================================================
-- Migration 0030: 筆記關聯連結建議 (Note Link Suggestions)
--
-- 為「已有內容的筆記」動態建議相關去處。原理與 相似題目 一致:
-- 先有一份「受控關鍵字詞表」(直接沿用 question_tags 的疾病/主題標籤),
-- 再用關鍵字匹配 —— 全確定性 SQL,執行期零 Workers AI 神經元。
--
-- 連結範圍(與 owner 確認):
--   • 私人筆記 → 只連到「同一使用者自己」的其他私人筆記(不跨人,
--     守住 0009 的隱私設計 —— 別人的筆記永遠看不到)
--   • 筆記 → 所有公開題目(含其共筆詳解)
--
-- 成本控制:寫入端只把筆記標記為 needs_relink=1(極便宜)。計算走
--   (a) 讀取端惰性計算(單則,fetch handler,CPU 充裕)—— 讓建議「即時」出現
--   (b) 每日 cron 批次 drainRelinkQueue(),帶「寫入預算上限」把突發的
--       大量筆記自動分攤到 2~3 個晚上,永遠替白天 app 留安全邊際
-- 詳見 docs/plans/2026-07-21-note-link-suggestions-design.md
-- ============================================================

-- 1) 受控詞表 + IDF 權重(派生;dcron 夜間由 question_tags 重建)。
--    idf 讓罕見疾病詞(Richter transformation)權重高、常見詞(血液)幾乎
--    不貢獻分數 —— 這是「避免過多連結」的核心閘門。
CREATE TABLE keyword_vocab (
  term        TEXT    PRIMARY KEY,   -- 來自 DISTINCT question_tags.tag
  df          INTEGER NOT NULL,      -- document frequency:帶此 tag 的題數
  idf         REAL    NOT NULL,      -- ln(N_questions / (1 + df))
  updated_at  INTEGER NOT NULL
);

-- 2) 每則筆記命中的受控詞(normalized;供 SQL 集合運算)。
--    以 (user_email, question_id) 對到 personal_notes;筆記刪除時連帶清掉。
CREATE TABLE note_terms (
  user_email   TEXT NOT NULL,
  question_id  TEXT NOT NULL,
  term         TEXT NOT NULL,
  PRIMARY KEY (user_email, question_id, term),
  FOREIGN KEY (user_email, question_id)
    REFERENCES personal_notes(user_email, question_id) ON DELETE CASCADE
);
-- 反向 join:給定一個詞,找出還有哪些筆記 / 題目也命中它。
CREATE INDEX idx_note_terms_term ON note_terms(term);

-- 3) 建議快取(派生;可隨時由計算覆寫,語意同 review_progress 是快取)。
CREATE TABLE note_link_suggestions (
  user_email    TEXT    NOT NULL,     -- 這則筆記的擁有者
  question_id   TEXT    NOT NULL,     -- 這則筆記(personal_notes 的 PK 之一)
  target_kind   TEXT    NOT NULL,     -- 'note'(自己的另一則筆記) | 'question'
  target_id     TEXT    NOT NULL,     -- 目標的 question_id
  score         REAL    NOT NULL,     -- Σ idf(共享詞)
  shared_terms  TEXT    NOT NULL,     -- JSON string[],可解釋「因為都提到 AML」
  computed_at   INTEGER NOT NULL,
  PRIMARY KEY (user_email, question_id, target_kind, target_id),
  FOREIGN KEY (user_email, question_id)
    REFERENCES personal_notes(user_email, question_id) ON DELETE CASCADE
);
CREATE INDEX idx_note_links_by_note
  ON note_link_suggestions(user_email, question_id, score DESC);

-- 4) 髒標記:筆記一存檔就設 1,計算完設 0。cron 只掃 =1 的列(部分索引)。
ALTER TABLE personal_notes ADD COLUMN needs_relink INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_notes_relink ON personal_notes(updated_at) WHERE needs_relink = 1;

-- 既有筆記全部標記為待計算,由 cron 依預算逐晚 backfill(不會一次爆量)。
UPDATE personal_notes SET needs_relink = 1;

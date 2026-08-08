-- ============================================================
-- Migration 0040: 其他筆記(自由筆記)— free_notes
--
-- 一則不掛在任何題目上的私人筆記。personal_notes.question_id 有
-- REFERENCES questions(id),沒辦法用假題號當佔位 —— 那得先在 questions 裡
-- 插一列假題目,而題數統計、隨機出題、匯出全都是 SELECT ... FROM questions。
-- 新開一張表比較便宜。
--
-- 連帶把 note_terms / note_link_suggestions 的「擁有者」一般化:原本的鍵是
-- (user_email, question_id),自由筆記沒有 question_id。改成 owner_kind +
-- owner_id 之後,自由筆記與題目筆記互相推薦是同一段 SQL,不是兩套。
--
-- 為什麼不直接把自由筆記的 id 塞進 question_id 欄位:格式不會撞
-- (114-001 vs 亂數),所以「能動」—— 但那會讓欄名說謊,而這兩張表的每一條
-- 查詢都靠欄名讀懂。0036 已經示範過重建表的做法。
--
-- 詳見 docs/plans/2026-08-07-free-notes-design.md
-- ============================================================

-- 1) 自由筆記本體
CREATE TABLE free_notes (
  id           TEXT    PRIMARY KEY,   -- 短亂數;出現在網址上,所以不是流水號
  user_email   TEXT    NOT NULL REFERENCES users(email) ON DELETE CASCADE,
  title        TEXT    NOT NULL DEFAULT '',
  content_json TEXT    NOT NULL,      -- TipTap ProseMirror JSON
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  needs_relink INTEGER NOT NULL DEFAULT 0,  -- 建議待重算(語意同 personal_notes)
  tagged_hash  TEXT                          -- 上次產 AI 標籤時的內容雜湊
);
CREATE INDEX idx_free_notes_by_user ON free_notes(user_email, updated_at DESC);
CREATE INDEX idx_free_notes_relink ON free_notes(updated_at) WHERE needs_relink = 1;

-- 2) 標籤。source 分開記,重跑 AI 時只刪掉 'ai' 的那批再重新插入。
--
--    'hidden' 是墓碑:使用者刪掉一個標籤時不是把列刪掉,而是把它改成
--    'hidden'。AI 重跑用 INSERT OR IGNORE,墓碑佔著 PK,所以被刪掉的標籤
--    不會下次打開筆記又長回來 —— 真的刪掉列的話它一定會回來,因為模型每次
--    看同一份內容都會給出同一組標籤。
CREATE TABLE free_note_tags (
  note_id    TEXT    NOT NULL REFERENCES free_notes(id) ON DELETE CASCADE,
  tag        TEXT    NOT NULL,
  source     TEXT    NOT NULL,   -- 'ai' | 'user' | 'hidden'(墓碑)
  created_at INTEGER NOT NULL,
  PRIMARY KEY (note_id, tag)
);
CREATE INDEX idx_free_note_tags_tag ON free_note_tags(tag);

-- 3) note_terms —— (user_email, question_id) → (user_email, owner_kind, owner_id)
--    既有列一律是題目筆記。0036 已經拿掉 FK,這裡維持不帶 FK:notes.ts 本來
--    就自己顯式刪(不依賴 PRAGMA 狀態)。
CREATE TABLE note_terms_new (
  user_email   TEXT NOT NULL,
  owner_kind   TEXT NOT NULL,   -- 'question' | 'free'
  owner_id     TEXT NOT NULL,   -- question_id | free_notes.id
  term         TEXT NOT NULL,
  PRIMARY KEY (user_email, owner_kind, owner_id, term)
);
INSERT INTO note_terms_new (user_email, owner_kind, owner_id, term)
  SELECT user_email, 'question', question_id, term FROM note_terms;
DROP TABLE note_terms;
ALTER TABLE note_terms_new RENAME TO note_terms;
-- 反向 join:給定一個詞,找出還有哪些筆記命中它。
CREATE INDEX idx_note_terms_term ON note_terms(term);

-- 4) note_link_suggestions —— 同樣一般化;target_kind 多一個 'free'。
CREATE TABLE note_link_suggestions_new (
  user_email    TEXT    NOT NULL,
  owner_kind    TEXT    NOT NULL,   -- 'question' | 'free'
  owner_id      TEXT    NOT NULL,
  target_kind   TEXT    NOT NULL,   -- 'question' | 'note'(自己的題目筆記) | 'free'
  target_id     TEXT    NOT NULL,
  score         REAL    NOT NULL,
  shared_terms  TEXT    NOT NULL,   -- JSON string[]
  computed_at   INTEGER NOT NULL,
  PRIMARY KEY (user_email, owner_kind, owner_id, target_kind, target_id)
);
INSERT INTO note_link_suggestions_new
  (user_email, owner_kind, owner_id, target_kind, target_id, score, shared_terms, computed_at)
  SELECT user_email, 'question', question_id, target_kind, target_id, score, shared_terms, computed_at
    FROM note_link_suggestions;
DROP TABLE note_link_suggestions;
ALTER TABLE note_link_suggestions_new RENAME TO note_link_suggestions;
CREATE INDEX idx_note_links_by_note
  ON note_link_suggestions(user_email, owner_kind, owner_id, score DESC);

-- 5) 既有題目筆記全部標成待重算 —— 現在多了「自由筆記」這種候選目標,
--    舊的建議算的時候還不存在這個來源。跟 0030 一樣由 cron 依預算逐晚消化,
--    不會一次爆量。
UPDATE personal_notes SET needs_relink = 1;

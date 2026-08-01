-- ============================================================
-- Migration 0036: 一題可以有多則個人筆記
--
-- personal_notes 原本是 (user_email, question_id) 一列到底。加上 slot 之後
-- 同一題可以並存好幾則:0 是既有那則(所有舊入口 —— MCQ skill API、
-- enrich-note 批次腳本 —— 仍然打得到同一個地方),1、2… 是後來新增的。
--
-- 連帶要動三張表:
--   note_terms / note_link_suggestions
--     它們用複合 FK 指向 personal_notes(user_email, question_id)。加了 slot
--     之後那組欄位不再唯一,SQLite 的 FK 父鍵必須是唯一索引 —— 留著會變成
--     「foreign key mismatch」,連 INSERT 都做不了。改成不帶 FK:notes.ts
--     本來就自己顯式刪(見那裡的註解:「不依賴 PRAGMA 狀態」),語意不變。
--     兩者仍以「一題一組」為單位,建議是由該題全部筆記合起來算的。
--   note_cloze
--     自動挖空的快取,PK 補 slot —— 否則第二則筆記會讀到第一則的關鍵詞。
--
-- 順序:先重建兩張子表(拿掉 FK),再重建 personal_notes。反過來做的話,
-- DROP TABLE personal_notes 會撞上還指著它的 FK。
-- ============================================================

-- 1) note_terms —— 去掉 FK,其餘原樣
CREATE TABLE note_terms_new (
  user_email   TEXT NOT NULL,
  question_id  TEXT NOT NULL,
  term         TEXT NOT NULL,
  PRIMARY KEY (user_email, question_id, term)
);
INSERT INTO note_terms_new (user_email, question_id, term)
  SELECT user_email, question_id, term FROM note_terms;
DROP TABLE note_terms;
ALTER TABLE note_terms_new RENAME TO note_terms;
CREATE INDEX idx_note_terms_term ON note_terms(term);

-- 2) note_link_suggestions —— 去掉 FK,其餘原樣
CREATE TABLE note_link_suggestions_new (
  user_email    TEXT    NOT NULL,
  question_id   TEXT    NOT NULL,
  target_kind   TEXT    NOT NULL,
  target_id     TEXT    NOT NULL,
  score         REAL    NOT NULL,
  shared_terms  TEXT    NOT NULL,
  computed_at   INTEGER NOT NULL,
  PRIMARY KEY (user_email, question_id, target_kind, target_id)
);
INSERT INTO note_link_suggestions_new
  (user_email, question_id, target_kind, target_id, score, shared_terms, computed_at)
  SELECT user_email, question_id, target_kind, target_id, score, shared_terms, computed_at
    FROM note_link_suggestions;
DROP TABLE note_link_suggestions;
ALTER TABLE note_link_suggestions_new RENAME TO note_link_suggestions;
CREATE INDEX idx_note_links_by_note
  ON note_link_suggestions(user_email, question_id, score DESC);

-- 3) personal_notes —— PK 補 slot,順便補 created_at(下拉選單依建立順序排,
--    updated_at 會因為編輯而跳動,拿來排序會讓筆記在選單裡換位置)。
CREATE TABLE personal_notes_new (
  user_email   TEXT NOT NULL REFERENCES users(email) ON DELETE CASCADE,
  question_id  TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  slot         INTEGER NOT NULL DEFAULT 0,
  content_json TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  needs_relink INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_email, question_id, slot)
);
-- 既有筆記一律是 slot 0;沒有建立時間可考,就用最後編輯時間當建立時間。
INSERT INTO personal_notes_new
  (user_email, question_id, slot, content_json, created_at, updated_at, needs_relink)
  SELECT user_email, question_id, 0, content_json, updated_at, updated_at, needs_relink
    FROM personal_notes;
DROP TABLE personal_notes;
ALTER TABLE personal_notes_new RENAME TO personal_notes;
CREATE INDEX idx_notes_by_user ON personal_notes(user_email, updated_at DESC);
CREATE INDEX idx_notes_relink ON personal_notes(updated_at) WHERE needs_relink = 1;

-- 4) note_cloze —— 快取,PK 補 slot
CREATE TABLE note_cloze_new (
  user_email   TEXT    NOT NULL,
  question_id  TEXT    NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  slot         INTEGER NOT NULL DEFAULT 0,
  content_hash TEXT    NOT NULL,
  terms_json   TEXT    NOT NULL,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (user_email, question_id, slot)
);
INSERT INTO note_cloze_new
  (user_email, question_id, slot, content_hash, terms_json, created_at)
  SELECT user_email, question_id, 0, content_hash, terms_json, created_at FROM note_cloze;
DROP TABLE note_cloze;
ALTER TABLE note_cloze_new RENAME TO note_cloze;

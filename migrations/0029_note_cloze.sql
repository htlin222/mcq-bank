-- ============================================================
-- Migration 0029: 個人筆記的自動挖空關鍵詞快取
--
-- Mirror of `explanation_cloze`, but per-user: a 個人筆記 belongs to one
-- reader, so the extracted terms must not be shared. A private note has no
-- version column, so the cache is keyed by a hash of `content_json` — edit
-- the note and the next 自動挖空 recomputes; leave it alone and repeated
-- presses cost zero Workers AI neurons.
--
-- Deliberately NOT stored alongside 個人畫記 (`highlights`): 畫記 is the
-- reader's own durable layer, cloze terms are machine-generated scaffolding
-- that gets thrown away and recomputed. Mixing them is what made the old
-- behaviour unpredictable.
-- ============================================================

CREATE TABLE note_cloze (
  user_email   TEXT    NOT NULL,
  question_id  TEXT    NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  content_hash TEXT    NOT NULL,   -- djb2 of the note's content_json at compute time
  terms_json   TEXT    NOT NULL,   -- JSON string[] of key terms
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (user_email, question_id)
);

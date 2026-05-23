-- ============================================================
-- Migration 0009: 個人筆記 + cross-question reference index
--
-- Adds:
--   personal_notes   — private per-user TipTap doc, one row per
--                      (user, question). No version/lock/history.
--   question_refs    — index of @YYY-NNN references emitted from
--                      explanations and comments. Notes are
--                      deliberately NOT indexed (privacy: would
--                      leak study patterns to other users).
-- ============================================================

CREATE TABLE personal_notes (
  user_email   TEXT NOT NULL REFERENCES users(email) ON DELETE CASCADE,
  question_id  TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  content_json TEXT NOT NULL,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (user_email, question_id)
);

CREATE INDEX idx_notes_by_user ON personal_notes(user_email, updated_at DESC);

CREATE TABLE question_refs (
  source_type        TEXT NOT NULL,
  source_id          TEXT NOT NULL,
  target_question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  by_email           TEXT NOT NULL,
  created_at         INTEGER NOT NULL,
  PRIMARY KEY (source_type, source_id, target_question_id)
);

CREATE INDEX idx_refs_by_target ON question_refs(target_question_id, created_at DESC);

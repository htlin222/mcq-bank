-- ============================================================
-- Migration 0012: FSRS-backed Anki review
--
-- Adds durable per-user scheduling state for each question card plus
-- append-only review logs. Questions remain the canonical card content;
-- each exam year acts as a deck.
-- ============================================================

CREATE TABLE fsrs_cards (
  user_email      TEXT NOT NULL REFERENCES users(email) ON DELETE CASCADE,
  question_id     TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  due_at          INTEGER NOT NULL,
  stability       REAL NOT NULL,
  difficulty      REAL NOT NULL,
  elapsed_days    INTEGER NOT NULL DEFAULT 0,
  scheduled_days  INTEGER NOT NULL DEFAULT 0,
  learning_steps  INTEGER NOT NULL DEFAULT 0,
  reps            INTEGER NOT NULL DEFAULT 0,
  lapses          INTEGER NOT NULL DEFAULT 0,
  state           INTEGER NOT NULL DEFAULT 0,
  last_review_at  INTEGER,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY (user_email, question_id)
);

CREATE INDEX idx_fsrs_cards_due
  ON fsrs_cards(user_email, due_at);

CREATE INDEX idx_fsrs_cards_question
  ON fsrs_cards(question_id);

CREATE TABLE fsrs_review_logs (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  user_email        TEXT NOT NULL REFERENCES users(email) ON DELETE CASCADE,
  question_id       TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  rating            INTEGER NOT NULL,
  state             INTEGER NOT NULL,
  due_at            INTEGER NOT NULL,
  stability         REAL NOT NULL,
  difficulty        REAL NOT NULL,
  elapsed_days      INTEGER NOT NULL DEFAULT 0,
  last_elapsed_days INTEGER NOT NULL DEFAULT 0,
  scheduled_days    INTEGER NOT NULL DEFAULT 0,
  learning_steps    INTEGER NOT NULL DEFAULT 0,
  reviewed_at       INTEGER NOT NULL,
  created_at        INTEGER NOT NULL
);

CREATE INDEX idx_fsrs_logs_user_reviewed
  ON fsrs_review_logs(user_email, reviewed_at DESC);

CREATE INDEX idx_fsrs_logs_question
  ON fsrs_review_logs(question_id, reviewed_at DESC);

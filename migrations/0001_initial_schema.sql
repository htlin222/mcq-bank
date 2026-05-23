-- ============================================================
-- Migration 0001: Initial schema
-- 1000 questions × 10 years, collaborative explanations,
-- threaded comments with mentions, exam sessions, review tracking
-- ============================================================

-- Users (identity sourced from Cloudflare Access; we just augment)
CREATE TABLE users (
  email          TEXT PRIMARY KEY,
  display_name   TEXT NOT NULL,
  avatar_key     TEXT,              -- R2 object key, NULL = default
  bio            TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

-- Questions: 1000 total, 10 years × 100/year
CREATE TABLE questions (
  id             TEXT PRIMARY KEY,  -- e.g. "2024-001"
  year           INTEGER NOT NULL,  -- 2015..2024
  number         INTEGER NOT NULL,  -- 1..100
  stem           TEXT NOT NULL,     -- 題幹 (markdown allowed)
  options_json   TEXT NOT NULL,     -- '[{"key":"A","text":"..."},...]'
  answer         TEXT NOT NULL,     -- 'A' | 'B' | ...
  category       TEXT,              -- 科目分類, e.g. "內科", "外科"
  difficulty     INTEGER,           -- 1-5 (NULL ok)
  source         TEXT,              -- 來源備註
  created_at     INTEGER NOT NULL
);

CREATE UNIQUE INDEX idx_q_year_num ON questions(year, number);
CREATE INDEX idx_q_year ON questions(year);
CREATE INDEX idx_q_category ON questions(category);

-- Explanations: ONE shared collaborative wiki entry per question
CREATE TABLE explanations (
  question_id    TEXT PRIMARY KEY REFERENCES questions(id) ON DELETE CASCADE,
  content_json   TEXT NOT NULL DEFAULT '{"type":"doc","content":[]}',  -- TipTap JSON
  version        INTEGER NOT NULL DEFAULT 0,
  editing_by     TEXT,              -- email of current locker (NULL = free)
  editing_until  INTEGER,           -- unix ms, lock expiry
  updated_by     TEXT,
  updated_at     INTEGER NOT NULL
);

-- Version history (full snapshot per save — D1 storage is cheap enough)
CREATE TABLE explanation_history (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  question_id    TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  version        INTEGER NOT NULL,
  content_json   TEXT NOT NULL,
  updated_by     TEXT NOT NULL,
  updated_at     INTEGER NOT NULL
);

CREATE INDEX idx_eh_question ON explanation_history(question_id, version DESC);

-- Comments: threaded discussion under each question
CREATE TABLE comments (
  id             TEXT PRIMARY KEY,
  question_id    TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  parent_id      TEXT REFERENCES comments(id) ON DELETE CASCADE,
  author_email   TEXT NOT NULL REFERENCES users(email),
  content_json   TEXT NOT NULL,     -- TipTap JSON
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  deleted_at     INTEGER            -- soft delete; preserve thread integrity
);

CREATE INDEX idx_c_question ON comments(question_id, created_at);
CREATE INDEX idx_c_parent ON comments(parent_id);
CREATE INDEX idx_c_author ON comments(author_email);

-- Mention index (extracted from comment/explanation content)
CREATE TABLE mentions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  source_type    TEXT NOT NULL,     -- 'comment' | 'explanation'
  source_id      TEXT NOT NULL,
  mentioned_email TEXT NOT NULL,
  by_email       TEXT NOT NULL,
  question_id    TEXT NOT NULL,
  created_at     INTEGER NOT NULL
);

CREATE INDEX idx_m_mentioned ON mentions(mentioned_email, created_at);

-- Notifications (in-app inbox; @mentions, replies, edit notices)
CREATE TABLE notifications (
  id             TEXT PRIMARY KEY,
  recipient      TEXT NOT NULL,
  kind           TEXT NOT NULL,     -- 'mention' | 'reply' | 'edit'
  question_id    TEXT,
  comment_id     TEXT,
  actor_email    TEXT,
  preview        TEXT,              -- short text excerpt
  read_at        INTEGER,
  created_at     INTEGER NOT NULL
);

CREATE INDEX idx_n_recipient ON notifications(recipient, created_at DESC);
CREATE INDEX idx_n_unread ON notifications(recipient, read_at);

-- Mock exam sessions (全真作答)
CREATE TABLE exam_sessions (
  id             TEXT PRIMARY KEY,
  user_email     TEXT NOT NULL REFERENCES users(email),
  year           INTEGER NOT NULL,  -- which year's exam
  started_at     INTEGER NOT NULL,
  finished_at    INTEGER,           -- NULL = in progress
  score          INTEGER,           -- correct count out of 100
  duration_sec   INTEGER,
  mode           TEXT DEFAULT 'full' -- 'full' | 'partial'
);

CREATE INDEX idx_es_user ON exam_sessions(user_email, started_at DESC);

-- Exam answers (one row per (session, question))
CREATE TABLE exam_answers (
  session_id     TEXT NOT NULL REFERENCES exam_sessions(id) ON DELETE CASCADE,
  question_id    TEXT NOT NULL REFERENCES questions(id),
  chosen         TEXT,              -- 'A'..'D' or NULL (unanswered)
  is_correct     INTEGER,           -- 0/1, computed at submit
  answered_at    INTEGER,
  PRIMARY KEY (session_id, question_id)
);

-- Review mode progress (per-user spaced-repetition lite)
CREATE TABLE review_progress (
  user_email     TEXT NOT NULL REFERENCES users(email),
  question_id    TEXT NOT NULL REFERENCES questions(id),
  times_seen     INTEGER NOT NULL DEFAULT 0,
  times_correct  INTEGER NOT NULL DEFAULT 0,
  last_seen_at   INTEGER,
  last_chosen    TEXT,              -- last answer they picked
  last_correct   INTEGER,           -- 0/1
  bookmarked     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_email, question_id)
);

CREATE INDEX idx_rp_user ON review_progress(user_email, last_seen_at DESC);
CREATE INDEX idx_rp_bookmark ON review_progress(user_email, bookmarked);

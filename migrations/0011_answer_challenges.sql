-- ============================================================
-- Migration 0011: 答案挑戰 (answer challenges)
--
-- A user can challenge the canonical answer of a question with
-- a rationale; other users vote agree/disagree. If consensus is
-- reached, the question.answer is destructively flipped and the
-- prior value is preserved in answer_history.
--
-- State machine:
--   open       --(2 agrees, 0 disagrees)-->  promoted
--   open       --(any disagree)----------->  contested
--   contested  --(>=4 agrees, net >= +3,
--                 48h since first disagree)-> promoted
--   contested  --(net <= -2, 48h)--------->  rejected
--   contested  --(14d no activity)------->  archived
--   any        --(proposer withdraws)---->  withdrawn
--
-- One open/contested challenge per question (partial UNIQUE index).
-- After any resolve, a fresh challenge may be filed immediately.
-- ============================================================

CREATE TABLE answer_challenges (
  id                            TEXT PRIMARY KEY,
  question_id                   TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  proposer_email                TEXT NOT NULL REFERENCES users(email),
  proposed_answer               TEXT NOT NULL,                  -- 'A'..'E'
  original_answer_at_challenge  TEXT NOT NULL,                  -- snapshot at create
  rationale_json                TEXT NOT NULL,                  -- TipTap doc
  status                        TEXT NOT NULL DEFAULT 'open',   -- open|contested|promoted|rejected|archived|withdrawn
  contested_at                  INTEGER,                        -- ms; set on first disagree
  created_at                    INTEGER NOT NULL,
  resolved_at                   INTEGER,
  resolution_reason             TEXT                            -- 'auto:fast'|'auto:strict'|'auto:rejected'|'auto:archived'|'withdrawn'
);

-- Only one active challenge per question. Partial unique index is supported
-- by D1 (SQLite >= 3.8).
CREATE UNIQUE INDEX idx_one_active_challenge_per_question
  ON answer_challenges(question_id)
  WHERE status IN ('open', 'contested');

CREATE INDEX idx_challenges_recent ON answer_challenges(status, created_at DESC);
CREATE INDEX idx_challenges_by_question ON answer_challenges(question_id, created_at DESC);

CREATE TABLE challenge_votes (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  challenge_id    TEXT NOT NULL REFERENCES answer_challenges(id) ON DELETE CASCADE,
  voter_email     TEXT NOT NULL REFERENCES users(email),
  vote            TEXT NOT NULL,                                 -- 'agree' | 'disagree'
  comment_json    TEXT,                                          -- optional TipTap doc
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  UNIQUE(challenge_id, voter_email)
);

CREATE INDEX idx_challenge_votes_by_challenge ON challenge_votes(challenge_id);

-- Authoritative history of the canonical answer for each question.
-- On the first promote of a given question, we lazily insert a baseline
-- row with source='original' so the original (pre-community) answer is
-- always retrievable.
CREATE TABLE answer_history (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  question_id      TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  previous_answer  TEXT NOT NULL,
  new_answer       TEXT NOT NULL,
  source           TEXT NOT NULL,                                -- 'original' | 'challenge' | 'admin'
  challenge_id     TEXT REFERENCES answer_challenges(id) ON DELETE SET NULL,
  changed_by       TEXT,                                         -- email; NULL for 'original'
  changed_at       INTEGER NOT NULL
);

CREATE INDEX idx_answer_history_by_question ON answer_history(question_id, changed_at DESC);

-- When the canonical answer flips, the existing wiki 詳解 may be stale.
-- We auto-prepend a system note and set stale_since; clears on next save.
ALTER TABLE explanations ADD COLUMN stale_since INTEGER;

-- Snapshot the canonical answer at exam-finish time so a later challenge
-- promotion does not retroactively re-score historical attempts.
-- NULL on rows from finished sessions pre-migration; scoring code can
-- fall back to the live questions.answer for those (best-effort).
ALTER TABLE exam_answers ADD COLUMN correct_answer_at_finish TEXT;

-- Click-through target for challenge notifications.
ALTER TABLE notifications ADD COLUMN challenge_id TEXT;

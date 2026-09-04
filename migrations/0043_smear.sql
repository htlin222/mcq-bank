-- ============================================================
-- Migration 0043: 抹片練習
--
-- 設計:docs/plans/2026-09-03-smear-practice-design.md
--
-- ⚠️ alias 與詳解掛「診斷」(smear_dx)不掛「題目」(smear_questions)。
--    同一個 dacrocyte 有考古題 1 張 + ASH 3 張 = 4 題;alias 掛題目的話,
--    新增一個「dacryocyte 也算對」要改 4 筆,而漏改的那一筆症狀是
--    「同一個答案,這張圖算我對、那張圖算我錯」—— 沒有人回報得清楚。
--
-- ⚠️ 作答記錄不進 attempts。attempts.question_id 有 FK 指向 questions,
--    而抹片題不在那張表裡;動那個 FK 等於讓 attempts 的每一條既有查詢
--    都要多想一次。
-- ============================================================

CREATE TABLE smear_dx (
  id               TEXT PRIMARY KEY,     -- slug, e.g. 'dacrocyte'
  canonical_long   TEXT NOT NULL,
  canonical_abbrev TEXT,                 -- 沒有就是 NULL,不硬造
  topic            TEXT NOT NULL,        -- myeloid|lymphoid|normal_reactive|rbc|platelet|infection|other
  qtype            TEXT NOT NULL,        -- cell|disease
  created_at       INTEGER NOT NULL
);
CREATE INDEX idx_smear_dx_topic ON smear_dx(topic);

-- 一列 = 一個可接受的寫法。status 同時是提報流程的狀態機:
--   accepted  判定時採用
--   open      投票中,判定時不採用
--   rejected  墓碑 —— 不能刪列,否則同一個詞會被反覆提報
CREATE TABLE smear_terms (
  id          TEXT PRIMARY KEY,
  dx_id       TEXT NOT NULL REFERENCES smear_dx(id) ON DELETE CASCADE,
  text        TEXT NOT NULL,             -- 原樣,顯示用
  norm        TEXT NOT NULL,             -- normalizeTerm(text),比對用
  tier        TEXT NOT NULL,             -- full|half|lay
  form        TEXT NOT NULL,             -- long|abbrev
  status      TEXT NOT NULL,             -- accepted|open|rejected
  rationale   TEXT,
  proposed_by TEXT,
  created_at  INTEGER NOT NULL,
  resolved_at INTEGER
);
-- 墓碑靠這個唯一鍵擋住重複提報。
CREATE UNIQUE INDEX idx_smear_terms_uniq ON smear_terms(dx_id, norm);
CREATE INDEX idx_smear_terms_dx ON smear_terms(dx_id, status);

CREATE TABLE smear_term_votes (
  term_id     TEXT NOT NULL REFERENCES smear_terms(id) ON DELETE CASCADE,
  voter_email TEXT NOT NULL REFERENCES users(email) ON DELETE CASCADE,
  agree       INTEGER NOT NULL,          -- 1|0
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (term_id, voter_email)
);

CREATE TABLE smear_questions (
  id             TEXT PRIMARY KEY,       -- 'exam-t3-018' / 'ash-66486'
  dx_id          TEXT NOT NULL REFERENCES smear_dx(id) ON DELETE CASCADE,
  source         TEXT NOT NULL,          -- exam|ash|po
  source_ref     TEXT,                   -- deck+page / ASH image id
  source_url     TEXT,
  attribution    TEXT,
  image_key_view TEXT NOT NULL,          -- R2 key,長邊 1600
  image_key_full TEXT NOT NULL,          -- R2 key,長邊 2400
  prompt         TEXT,                   -- 'What disease?' / 'What cell?'
  image_note     TEXT,                   -- 箭頭 / A-B 說明(這張圖的事,不是這個診斷的事)
  created_at     INTEGER NOT NULL
);
CREATE INDEX idx_smear_q_dx ON smear_questions(dx_id);
CREATE INDEX idx_smear_q_source ON smear_questions(source);

-- 共筆詳解,一個 dx 一份。鎖的形狀同 explanations。
CREATE TABLE smear_dx_notes (
  dx_id           TEXT PRIMARY KEY REFERENCES smear_dx(id) ON DELETE CASCADE,
  content_json    TEXT NOT NULL,
  related_dx_ids  TEXT,                  -- JSON array of dx_id,跨連結用,可為 NULL
  version         INTEGER NOT NULL DEFAULT 1,
  updated_by      TEXT,
  updated_at      INTEGER NOT NULL,
  editing_by      TEXT,
  editing_until   INTEGER
);

CREATE TABLE smear_sessions (
  id           TEXT PRIMARY KEY,
  user_email   TEXT NOT NULL REFERENCES users(email) ON DELETE CASCADE,
  mode         TEXT NOT NULL,            -- review|exam
  config_json  TEXT NOT NULL,            -- {n, form, topics[], sources[], limitSec}
  question_ids TEXT NOT NULL,            -- JSON array —— 抽好就固定,重整不重抽
  started_at   INTEGER NOT NULL,
  finished_at  INTEGER,
  score        REAL,
  max_score    REAL,
  spelling_ok  INTEGER,                  -- 拼字完全正確的題數
  lay_count    INTEGER                   -- 用了俗名的題數
);
CREATE INDEX idx_smear_sess_user ON smear_sessions(user_email, started_at DESC);

CREATE TABLE smear_answers (
  session_id           TEXT NOT NULL REFERENCES smear_sessions(id) ON DELETE CASCADE,
  question_id          TEXT NOT NULL REFERENCES smear_questions(id) ON DELETE CASCADE,
  idx                  INTEGER NOT NULL,
  typed_json           TEXT NOT NULL,    -- 格子陣列
  tier                 TEXT,             -- full|half|lay|miss
  score                REAL,
  spelling_errors_json TEXT,
  hint_used            TEXT,             -- NULL | 'initial,topic' 之類
  answered_at          INTEGER,
  PRIMARY KEY (session_id, question_id)
);

-- 搜尋跟 MCQ 完全分開,自己一份索引。
CREATE VIRTUAL TABLE smear_fts USING fts5(
  dx_id UNINDEXED, canonical, terms, topic, note, tokenize='unicode61'
);

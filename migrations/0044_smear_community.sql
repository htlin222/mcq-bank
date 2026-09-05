-- ============================================================
-- Migration 0044: 抹片練習 —— 收藏 / 個人筆記 / 討論 / 投稿
--
-- 三張表都用 dx_id 而不是 question_id 掛勾,理由跟整個抹片功能的組織方式
-- 一致:使用者研究的是「這個診斷」,不是某一張特定的圖。
--
-- 不重用既有 personal_notes/comments —— 那兩張表對 questions(id) 下了
-- 強制外鍵,而抹片題依設計不在那張表裡(同「自由筆記」0040 當初面對過
-- 一樣的問題,解法也一樣:另開專用表)。
-- ============================================================

CREATE TABLE smear_dx_bookmarks (
  user_email TEXT NOT NULL REFERENCES users(email) ON DELETE CASCADE,
  dx_id      TEXT NOT NULL REFERENCES smear_dx(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_email, dx_id)
);
CREATE INDEX idx_smear_bm_user ON smear_dx_bookmarks(user_email, created_at DESC);

CREATE TABLE smear_notes (
  id           TEXT PRIMARY KEY,
  user_email   TEXT NOT NULL REFERENCES users(email) ON DELETE CASCADE,
  dx_id        TEXT NOT NULL REFERENCES smear_dx(id) ON DELETE CASCADE,
  content_json TEXT NOT NULL,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX idx_smear_notes_user_dx ON smear_notes(user_email, dx_id, sort_order);

CREATE TABLE smear_comments (
  id           TEXT PRIMARY KEY,
  dx_id        TEXT NOT NULL REFERENCES smear_dx(id) ON DELETE CASCADE,
  parent_id    TEXT REFERENCES smear_comments(id) ON DELETE CASCADE,
  author_email TEXT NOT NULL REFERENCES users(email),
  content_json TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  deleted_at   INTEGER
);
CREATE INDEX idx_smear_comments_dx ON smear_comments(dx_id, created_at);
CREATE INDEX idx_smear_comments_parent ON smear_comments(parent_id);

-- 投稿:任何人都能傳,但 status='pending' 之前對其他人完全不可見、
-- 不進任何抽題池。matched_dx_id 由 normalizeTerm() 比對既有 accepted
-- terms 自動猜測,審核者可覆寫或清空。
CREATE TABLE smear_submissions (
  id               TEXT PRIMARY KEY,
  user_email       TEXT NOT NULL REFERENCES users(email) ON DELETE CASCADE,
  image_key        TEXT NOT NULL,
  proposed_answer  TEXT NOT NULL,
  explanation_text TEXT,
  status           TEXT NOT NULL DEFAULT 'pending',  -- pending|approved|rejected
  matched_dx_id    TEXT REFERENCES smear_dx(id),
  reviewed_by      TEXT,
  reviewed_at      INTEGER,
  review_note      TEXT,
  created_at       INTEGER NOT NULL
);
CREATE INDEX idx_smear_sub_status ON smear_submissions(status, created_at DESC);
CREATE INDEX idx_smear_sub_user ON smear_submissions(user_email, created_at DESC);

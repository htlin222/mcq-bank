-- ============================================================
-- Migration 0003: Switch year semantics + add group + tags
--
-- The original 0001 assumed CE years (2015..2024) and a free-form
-- `category`. The real exam uses 民國紀年 (104..114), and questions
-- belong to exactly one of two groups:
--   內科  (adult hematology, 70 per year, numbered 1..70)
--   共同  (adult + pediatric, 30 per year, numbered 71..100)
--
-- Tags are a separate, free-form, multi-valued metadata layer
-- (e.g. AML, MDS, ITP, thalassemia, hemophilia).
-- ============================================================

-- 1) Add group with CHECK constraint
ALTER TABLE questions ADD COLUMN "group" TEXT
  CHECK ("group" IN ('內科', '共同'));

-- 2) Drop category (and its index)
DROP INDEX IF EXISTS idx_q_category;
ALTER TABLE questions DROP COLUMN category;

-- 3) Composite index for the common list queries (year+group)
CREATE INDEX idx_q_year_group ON questions(year, "group");

-- 4) Free-form tags per question
CREATE TABLE question_tags (
  question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  tag         TEXT NOT NULL,
  created_by  TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (question_id, tag)
);

CREATE INDEX idx_tags_tag ON question_tags(tag);
CREATE INDEX idx_tags_question ON question_tags(question_id);

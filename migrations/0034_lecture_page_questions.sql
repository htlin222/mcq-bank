-- ============================================================
-- Migration 0034: 講義投影片 → 歷屆考題關聯 — lecture_page_questions
--
-- 一張投影片頁涵蓋到的歷屆 MCQ。離線 pipeline
-- (scripts/build-slide-mcq-links.ts) 產出，reader 右欄「歷屆考題」面板
-- (worker/routes/lectures.ts GET /:slug/questions) 讀取。page 為 1-based
-- PDF 頁碼，對齊 lecture_pages / lecture_notes 的頁碼慣例。
--
-- 詳見 docs/plans/2026-07-23-slide-mcq-links-design.md §3。
-- ============================================================

CREATE TABLE lecture_page_questions (
  slug        TEXT    NOT NULL,             -- lecture_docs.slug（kind='lecture'）
  page        INTEGER NOT NULL,             -- 1-based PDF page（= currentPage + 1）
  question_id TEXT    NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  score       REAL    NOT NULL,             -- LLM relevance 0..1，面板內排序用
  rank        INTEGER NOT NULL,             -- 頁內名次（0 = 最相關）
  method      TEXT    NOT NULL,             -- 'llm' | 'fts' | 'tag'（產出來源，除錯用）
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (slug, page, question_id)
);
CREATE INDEX idx_lpq_slug_page ON lecture_page_questions(slug, page);

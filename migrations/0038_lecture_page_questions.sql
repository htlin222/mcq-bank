-- ============================================================
-- Migration 0038: 講義投影片 → 歷屆考題關聯 — lecture_page_questions
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

-- 這裡刻意「不」另建 (slug, page) 的索引。複合 PRIMARY KEY 已經讓 SQLite
-- 建了 sqlite_autoindex_lecture_page_questions_1 於 (slug, page, question_id),
-- 而 (slug, page) 是它的前綴 —— 查詢計畫實測兩者相同:
--
--   SEARCH ... USING INDEX sqlite_autoindex_..._1 (slug=? AND page=?)
--
-- 多一條索引只是多一份寫入成本與空間,換不到任何存取路徑上的差別。

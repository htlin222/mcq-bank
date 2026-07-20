-- ============================================================
-- Migration 0026: Custom test builder sessions
--
-- 自訂測驗沿用 exam_sessions/exam_answers,不另開表。舊列的 DEFAULT
-- 就是原本的「年度全真考」語意,無需 backfill。
--
--   kind        'year'(依年份出卷,即 POST /api/exam/start)| 'custom'
--   tutor       1 = 每題作答後立即揭曉答案與詳解
--   timed       0 = 不計時(cap_ms 仍存在,但設得極大,前端改為往上計時)
--   filter_json 產生這份卷的篩選條件快照(可重跑 / 除錯用)
--
-- year 是 NOT NULL 且 SQLite 的 ALTER TABLE 不能放寬,custom 一律寫 0
-- 當哨兵;判斷種類請一律看 kind,不要看 year。
-- ============================================================

ALTER TABLE exam_sessions ADD COLUMN kind TEXT NOT NULL DEFAULT 'year';
ALTER TABLE exam_sessions ADD COLUMN tutor INTEGER NOT NULL DEFAULT 0;
ALTER TABLE exam_sessions ADD COLUMN timed INTEGER NOT NULL DEFAULT 1;
ALTER TABLE exam_sessions ADD COLUMN filter_json TEXT;

-- 自訂測驗跨年份時 q.number 會重複(114-007 與 113-007 都是 7),
-- 必須有明確的卷內順序。舊列為 NULL,查詢一律 COALESCE(ea.seq, q.number)
-- —— 對既有單年 session 完全等價。
ALTER TABLE exam_answers ADD COLUMN seq INTEGER;

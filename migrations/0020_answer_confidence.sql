-- ============================================================
-- Migration 0020: 答前信心 (pre-answer confidence / JOL)
--
-- Before revealing the answer in 複習模式, the user rates how sure
-- they are (1=猜 / 2=普通 / 3=有把握). Each answered attempt logs one
-- row here alongside whether it was correct. This powers the
-- calibration panel and the "高信心卻答錯" (hypercorrection candidate)
-- list. Confidence is optional — attempts without a rating write no row,
-- so the mock-exam flow is unaffected.
-- ============================================================

CREATE TABLE confidence_events (
  user_email  TEXT    NOT NULL REFERENCES users(email),
  question_id TEXT    NOT NULL REFERENCES questions(id),
  confidence  INTEGER NOT NULL,   -- 1=猜 2=普通 3=有把握
  is_correct  INTEGER NOT NULL,   -- 0/1
  at          INTEGER NOT NULL
);

CREATE INDEX idx_conf_user ON confidence_events (user_email, at DESC);

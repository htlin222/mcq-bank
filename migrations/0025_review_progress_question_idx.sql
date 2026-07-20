-- ============================================================
-- Migration 0025: review_progress(question_id) 索引
--
-- 選項分布統計以 question_id 反查全體作答。attempts 那側已有
-- idx_attempts_question (question_id, elapsed_ms),最左前綴吃得到;
-- review_progress 的 PK 是 (user_email, question_id),前綴不是
-- question_id,既有的兩個索引也都以 user_email 起頭 —— 因此
-- `WHERE question_id = ?` 會退化成全表掃描(既有的 /stats
-- attempts/correct 聚合查詢也一直如此)。補上索引,成本近乎零。
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_rp_question ON review_progress(question_id);

-- ============================================================
-- Migration 0028: 考試標記(mark for review)跨裝置同步
--
-- 「標記待回頭檢查」原本只存在瀏覽器 sessionStorage
-- (frontend/src/routes/Exam.tsx),換裝置、關分頁即消失。
-- 標記的自然鍵就是 (session_id, question_id) —— 與 exam_answers
-- 的 PK 相同,且 /start 與 /custom 都已為每一題(含未作答)預先建列,
-- 因此直接加欄位,不另開表。flagged 不參與計分。
--   flagged    0/1,預設 0
--   flagged_at 最後一次變更的 ms timestamp,供本機/server 對帳
-- ============================================================

ALTER TABLE exam_answers ADD COLUMN flagged INTEGER NOT NULL DEFAULT 0;
ALTER TABLE exam_answers ADD COLUMN flagged_at INTEGER;

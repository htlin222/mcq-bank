-- ============================================================
-- Migration 0027: 每週讀書目標 (study goals)
--
-- 只存「每週題數目標」一個值。進度本身刻意不存 —— 一律從
-- review_progress / attempts / fsrs_review_logs 即時算,避免第二個
-- 真相來源(見 docs/plans/2026-07-20-study-goals-and-pacing.md)。
-- 沒有 row = 尚未設定,API 依剩餘題數/天數給建議預設值。
--
-- 刻意不做 streak / 排行榜 / 積分 / 徽章欄位:漏一天歸零的設計對
-- 成年在職考生是棄坑觸發器,而 20 人熟人圈的公開排名只會製造壓力。
-- 每週目標保留「週三沒讀、週六補回來」的空間,仍然服務分散練習。
-- ============================================================

CREATE TABLE study_goals (
  user_email    TEXT    PRIMARY KEY REFERENCES users(email) ON DELETE CASCADE,
  weekly_target INTEGER NOT NULL,          -- 每週目標題數,1..1000
  updated_at    INTEGER NOT NULL           -- epoch ms
);

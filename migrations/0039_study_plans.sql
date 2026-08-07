-- ============================================================
-- Migration 0039: 讀書計畫問卷輸入 — study_plans
--
-- 一人一列，**只存輸入參數，不存排程結果**。排程是可從「輸入 + 當下進度」
-- 重算的衍生值（worker/lib/study-plan.ts 是純函式），存下來就會跟真實進度
-- 漂移 —— 而漂移的計畫表沒有人會發現它錯了。這與 review_progress 只被當作
-- 可重算的快取、attempts 才是真相來源，是同一條規則。
--
-- input_json 是 PlanInput 的 JSON（年份、每日分鐘、每題秒數、輪次、模擬考
-- 場次、休息日、讀書時段）。不建 CHECK 約束 —— 欄位形狀由 worker 端解析時
-- 逐一 clamp，schema 層再擋一次只會讓日後加一個問卷欄位變成一次 migration。
--
-- 詳見 docs/plans/2026-08-07-study-plan-generator-design.md。
-- ============================================================

CREATE TABLE study_plans (
  user_email TEXT PRIMARY KEY,
  input_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

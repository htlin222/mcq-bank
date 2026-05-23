-- ============================================================
-- Migration 0010: per-session exam time cap
--
-- Until now the 100-minute cap was a constant in code, which only
-- matched the full 100-question exam. Now users can mock only 內科
-- (70) or 共同 (30) — those need shorter caps. We store one minute
-- per question on the session row at /start time.
--
-- Existing rows get 6_000_000 ms (100 min) to match historical
-- behaviour.
-- ============================================================

ALTER TABLE exam_sessions ADD COLUMN cap_ms INTEGER NOT NULL DEFAULT 6000000;

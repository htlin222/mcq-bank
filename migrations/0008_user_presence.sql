-- ============================================================
-- Migration 0008: User presence (who is online)
--
-- Auth middleware updates `last_seen_at` at most once every 5 min
-- per user, so the write rate fits comfortably in D1's free tier
-- (≤ 20 users × 12 writes/hr × 8 hr ≈ 2K/day, vs 50K/day free).
--
-- "Online" = last_seen_at within the past 5 minutes.
-- ============================================================

ALTER TABLE users ADD COLUMN last_seen_at INTEGER;

CREATE INDEX idx_u_last_seen ON users(last_seen_at);

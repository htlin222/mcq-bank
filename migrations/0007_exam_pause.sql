-- ============================================================
-- Migration 0007: Pausable exam timer
--
-- The real 全真 exam is ~100 min. Users may need to leave their
-- desk; we track elapsed time explicitly so they can resume.
--
-- Time model:
--   elapsed_ms     — accumulated ticking from previous run-segments
--   running_since  — ts (ms) when the current ticking segment began;
--                    NULL ⇒ paused (no live tick).
--
-- live_elapsed_ms = elapsed_ms + (running_since == NULL ? 0 : now - running_since)
--
-- On finish, duration_sec is computed from live_elapsed_ms / 1000.
-- ============================================================

ALTER TABLE exam_sessions ADD COLUMN elapsed_ms INTEGER NOT NULL DEFAULT 0;
ALTER TABLE exam_sessions ADD COLUMN running_since INTEGER;

-- Backfill: any in-progress session whose started_at < now is "running" from
-- its original start. We can't know historical pause state, so treat them
-- as currently running with elapsed_ms=0 and running_since = started_at.
UPDATE exam_sessions
SET running_since = started_at
WHERE finished_at IS NULL;

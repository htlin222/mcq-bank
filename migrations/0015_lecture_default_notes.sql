-- ============================================================
-- Migration 0015: default lecture notes (auto-gifted at account setup)
--
-- Adds:
--   lecture_default_notes  — single canonical copy of the per-page
--                            lecture notes (TipTap JSON), keyed by
--                            (slug, page). Seeded by
--                            scripts/seed-lecture-notes.ts --defaults.
--   users.lecture_defaults_seeded — timestamp (ms) marking that this
--                            user's lecture_notes have been populated
--                            from lecture_default_notes. NULL = not yet.
--
-- On first authenticated request, the auth middleware claims the flag
-- atomically and copies lecture_default_notes into the user's private
-- lecture_notes — so future roster members get the gift automatically,
-- while edit/delete stay per-user.
--
-- Existing users already received the one-time bulk seed, so they are
-- marked seeded here to prevent a duplicate copy on their next login.
-- ============================================================

CREATE TABLE lecture_default_notes (
  slug         TEXT NOT NULL REFERENCES lecture_docs(slug) ON DELETE CASCADE,
  page         INTEGER NOT NULL,
  content_json TEXT NOT NULL,
  PRIMARY KEY (slug, page)
);

ALTER TABLE users ADD COLUMN lecture_defaults_seeded INTEGER;

-- Anyone who already has lecture notes got the one-time bulk gift.
-- Mark them seeded so the auth-time copy is a no-op for them.
UPDATE users
SET lecture_defaults_seeded = (CAST(strftime('%s','now') AS INTEGER) * 1000)
WHERE email IN (SELECT DISTINCT user_email FROM lecture_notes);

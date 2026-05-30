-- ============================================================
-- Migration 0014: 複習班講義 (review-class lecture PDFs)
--
-- Adds:
--   lecture_docs         — shared registry of the lecture PDFs, seeded
--                          by the import script. PDFs themselves live in
--                          R2 under key prefix `lectures/`.
--   lecture_annotations  — personal/private highlights + sticky notes,
--                          one row each (per user, per slug, per page).
--   lecture_notes        — personal/private page-anchored TipTap notebook
--                          (page NULL = deck-level note).
--
-- Annotations and notes are per-user and private, mirroring the
-- personal_notes design (no version/lock/history).
-- ============================================================

-- Shared registry (seeded by import script)
CREATE TABLE lecture_docs (
  slug        TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  instructor  TEXT,
  sort_order  INTEGER NOT NULL,
  r2_key      TEXT NOT NULL,
  page_count  INTEGER,
  bytes       INTEGER,
  created_at  INTEGER NOT NULL
);

-- Personal highlights + sticky notes (one row each)
CREATE TABLE lecture_annotations (
  id           TEXT PRIMARY KEY,
  user_email   TEXT NOT NULL REFERENCES users(email) ON DELETE CASCADE,
  slug         TEXT NOT NULL REFERENCES lecture_docs(slug) ON DELETE CASCADE,
  page         INTEGER NOT NULL,
  kind         TEXT NOT NULL,            -- 'highlight' | 'note'
  payload_json TEXT NOT NULL,            -- EmbedPDF geometry/color, or sticky text+anchor
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX idx_lecanno_user_slug_page ON lecture_annotations(user_email, slug, page);

-- Personal page-anchored notebook (TipTap)
CREATE TABLE lecture_notes (
  id           TEXT PRIMARY KEY,
  user_email   TEXT NOT NULL REFERENCES users(email) ON DELETE CASCADE,
  slug         TEXT NOT NULL REFERENCES lecture_docs(slug) ON DELETE CASCADE,
  page         INTEGER,                  -- NULL = deck-level note
  content_json TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX idx_lecnote_user_slug ON lecture_notes(user_email, slug);

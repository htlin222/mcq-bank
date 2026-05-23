-- ============================================================
-- Migration 0006: Bookmark folder system
--
-- Replaces the single `review_progress.bookmarked` flag with a richer
-- model: per-user named folders, items linked many-to-one to folders
-- (NULL = uncategorized).
--
-- Backfills existing bookmarked rows as uncategorized items.
-- ============================================================

CREATE TABLE bookmark_folders (
  id          TEXT PRIMARY KEY,
  user_email  TEXT NOT NULL REFERENCES users(email),
  name        TEXT NOT NULL,
  sort        INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  UNIQUE (user_email, name)
);

CREATE INDEX idx_bf_user ON bookmark_folders(user_email, sort);

CREATE TABLE bookmark_items (
  user_email  TEXT NOT NULL REFERENCES users(email),
  question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  folder_id   TEXT REFERENCES bookmark_folders(id) ON DELETE SET NULL,
  note        TEXT,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (user_email, question_id)
);

CREATE INDEX idx_bi_folder ON bookmark_items(folder_id, created_at DESC);
CREATE INDEX idx_bi_user ON bookmark_items(user_email, created_at DESC);

-- Backfill from existing bookmarks (folder_id = NULL → 未分類)
INSERT INTO bookmark_items (user_email, question_id, folder_id, created_at)
SELECT user_email, question_id, NULL, COALESCE(last_seen_at, strftime('%s','now') * 1000)
FROM review_progress
WHERE bookmarked = 1;

-- Drop the column now that bookmarks live in their own table.
DROP INDEX IF EXISTS idx_rp_bookmark;
ALTER TABLE review_progress DROP COLUMN bookmarked;

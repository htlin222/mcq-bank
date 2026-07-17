-- Per-user search history for the 搜尋 page recent-queries dropdown.
-- One row per (user, query); re-searching an existing query just bumps
-- created_at (upsert), so the table stays small and naturally deduped.
CREATE TABLE IF NOT EXISTS search_history (
  user_email TEXT    NOT NULL,
  query      TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_email, query)
);

CREATE INDEX IF NOT EXISTS idx_search_history_recent
  ON search_history (user_email, created_at DESC);

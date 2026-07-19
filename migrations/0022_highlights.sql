-- ============================================================
-- Migration 0022: 畫記跨裝置同步 (server-backed highlights)
--
-- Highlights (螢光標記) were a localStorage-only, per-device layer.
-- This table mirrors that blob per (user, store_key) so a user's
-- highlights follow them across devices. store_key is the same key the
-- client used for localStorage ('anno:exp:<qid>' for 共筆詳解,
-- 'anno:note:<qid>:<hash>' for a 個人筆記 section). content_hash is the
-- fingerprint of the underlying text — a changed source invalidates the
-- stored highlights (same rule as the old localStorage cache).
-- Per-user + private; last-write-wins by updated_at.
-- ============================================================

CREATE TABLE highlights (
  user_email   TEXT    NOT NULL REFERENCES users(email),
  store_key    TEXT    NOT NULL,
  content_hash TEXT    NOT NULL,
  doc_json     TEXT    NOT NULL,   -- annotated TipTap doc (highlight marks included)
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (user_email, store_key)
);

CREATE INDEX idx_highlights_user ON highlights (user_email, updated_at DESC);

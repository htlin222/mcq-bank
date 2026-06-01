-- ============================================================
-- Migration 0016: Full-text search for 複習班講義
--
-- Adds:
--   lecture_pages          — per-page extracted PDF plaintext (canonical).
--                            Populated by scripts/import-lectures.ts when
--                            PDFs are imported / re-imported.
--   lecture_pages_fts      — FTS5 over the above. Shared across users.
--   lecture_notes_fts      — FTS5 over lecture_notes.content_json, kept in
--                            sync by triggers that walk the TipTap JSON tree
--                            (json_tree → key='text', type='text') to extract
--                            pure text. Per-user (user_email UNINDEXED for
--                            filtering at query time).
--
-- Why two FTS tables instead of one:
--   PDF text is global; notes are per-user. Mixing them complicates per-user
--   filtering + ranking. Two tables keep each scope query trivial.
--
-- Tokenizer: unicode61 + remove_diacritics 2 — matches the existing
-- questions_fts pattern (migration 0005); handles CJK reasonably + strips
-- Latin diacritics.
-- ============================================================

-- ── PDF pages ────────────────────────────────────────────────────────

CREATE TABLE lecture_pages (
  slug TEXT NOT NULL REFERENCES lecture_docs(slug) ON DELETE CASCADE,
  page INTEGER NOT NULL,
  text TEXT NOT NULL,
  PRIMARY KEY (slug, page)
);

CREATE VIRTUAL TABLE lecture_pages_fts USING fts5(
  slug UNINDEXED,
  page UNINDEXED,
  text,
  tokenize = 'unicode61 remove_diacritics 2'
);

-- Mirror lecture_pages → lecture_pages_fts via triggers so the import script
-- only needs to touch lecture_pages.
CREATE TRIGGER lecture_pages_ai AFTER INSERT ON lecture_pages BEGIN
  INSERT INTO lecture_pages_fts(rowid, slug, page, text)
  VALUES (NEW.rowid, NEW.slug, NEW.page, NEW.text);
END;

CREATE TRIGGER lecture_pages_ad AFTER DELETE ON lecture_pages BEGIN
  DELETE FROM lecture_pages_fts WHERE rowid = OLD.rowid;
END;

CREATE TRIGGER lecture_pages_au AFTER UPDATE ON lecture_pages BEGIN
  DELETE FROM lecture_pages_fts WHERE rowid = OLD.rowid;
  INSERT INTO lecture_pages_fts(rowid, slug, page, text)
  VALUES (NEW.rowid, NEW.slug, NEW.page, NEW.text);
END;

-- ── Notes (per-user) ─────────────────────────────────────────────────

CREATE VIRTUAL TABLE lecture_notes_fts USING fts5(
  user_email UNINDEXED,
  slug       UNINDEXED,
  page       UNINDEXED,
  content,
  tokenize = 'unicode61 remove_diacritics 2'
);

-- Helper convention: extract pure text from a TipTap JSON document by
-- walking the tree with json_tree() and collecting every leaf node where
-- key='text' and type='text'. TipTap stores text-bearing nodes as
-- {"type":"text","text":"..."} — this matches both 'text' as object key
-- (json_tree's `key`) and the leaf string type ('text' in json_tree's
-- `type`). Inlined here rather than as a user-defined function because D1
-- doesn't support sqlite custom functions.

CREATE TRIGGER lecture_notes_ai AFTER INSERT ON lecture_notes BEGIN
  INSERT INTO lecture_notes_fts(rowid, user_email, slug, page, content)
  VALUES (
    NEW.rowid, NEW.user_email, NEW.slug, NEW.page,
    COALESCE(
      (SELECT GROUP_CONCAT(value, ' ')
         FROM json_tree(NEW.content_json)
        WHERE key = 'text' AND type = 'text'),
      ''
    )
  );
END;

CREATE TRIGGER lecture_notes_ad AFTER DELETE ON lecture_notes BEGIN
  DELETE FROM lecture_notes_fts WHERE rowid = OLD.rowid;
END;

CREATE TRIGGER lecture_notes_au AFTER UPDATE ON lecture_notes BEGIN
  DELETE FROM lecture_notes_fts WHERE rowid = OLD.rowid;
  INSERT INTO lecture_notes_fts(rowid, user_email, slug, page, content)
  VALUES (
    NEW.rowid, NEW.user_email, NEW.slug, NEW.page,
    COALESCE(
      (SELECT GROUP_CONCAT(value, ' ')
         FROM json_tree(NEW.content_json)
        WHERE key = 'text' AND type = 'text'),
      ''
    )
  );
END;

-- ── One-time backfill of lecture_notes_fts from existing rows ────────

INSERT INTO lecture_notes_fts(rowid, user_email, slug, page, content)
SELECT
  n.rowid, n.user_email, n.slug, n.page,
  COALESCE(
    (SELECT GROUP_CONCAT(value, ' ')
       FROM json_tree(n.content_json)
      WHERE key = 'text' AND type = 'text'),
    ''
  )
FROM lecture_notes n;

-- lecture_pages_fts is populated when scripts/import-lectures.ts inserts
-- into lecture_pages (which fires lecture_pages_ai). Run:
--   node --experimental-strip-types scripts/import-lectures.ts --remote --force
-- after applying this migration to populate it.

-- ============================================================
-- Migration 0005: Full-text search index
--
-- D1's SQLite supports FTS5 with the unicode61 tokenizer, which handles
-- CJK reasonably well (and removes diacritics from Latin terms).
--
-- We mirror searchable fields from `questions` + `question_tags` into
-- a virtual table, kept in sync via triggers. Queries use:
--   SELECT q.* FROM questions q
--     JOIN questions_fts f ON f.rowid = q.rowid
--    WHERE questions_fts MATCH ?
--    ORDER BY bm25(questions_fts);
-- ============================================================

CREATE VIRTUAL TABLE questions_fts USING fts5(
  question_id UNINDEXED,
  stem,
  options,        -- A. text / B. text / ... concatenated
  tags,           -- space-joined tags
  tokenize = 'unicode61 remove_diacritics 2'
);

-- Initial population
INSERT INTO questions_fts(rowid, question_id, stem, options, tags)
SELECT q.rowid, q.id, q.stem,
       COALESCE(
         (SELECT GROUP_CONCAT(
            COALESCE(json_extract(value, '$.key'), '') || '. ' ||
            COALESCE(json_extract(value, '$.text'), ''), ' '
          )
          FROM json_each(q.options_json)),
         ''
       ) AS options,
       COALESCE(
         (SELECT GROUP_CONCAT(tag, ' ')
          FROM question_tags
          WHERE question_id = q.id),
         ''
       ) AS tags
FROM questions q;

-- Keep stem/options in sync with questions
CREATE TRIGGER questions_fts_ai AFTER INSERT ON questions BEGIN
  INSERT INTO questions_fts(rowid, question_id, stem, options, tags)
  VALUES (
    NEW.rowid, NEW.id, NEW.stem,
    COALESCE(
      (SELECT GROUP_CONCAT(
         COALESCE(json_extract(value, '$.key'), '') || '. ' ||
         COALESCE(json_extract(value, '$.text'), ''), ' '
       )
       FROM json_each(NEW.options_json)),
      ''
    ),
    ''
  );
END;

CREATE TRIGGER questions_fts_ad AFTER DELETE ON questions BEGIN
  DELETE FROM questions_fts WHERE rowid = OLD.rowid;
END;

CREATE TRIGGER questions_fts_au AFTER UPDATE ON questions BEGIN
  UPDATE questions_fts
  SET stem = NEW.stem,
      options = COALESCE(
        (SELECT GROUP_CONCAT(
           COALESCE(json_extract(value, '$.key'), '') || '. ' ||
           COALESCE(json_extract(value, '$.text'), ''), ' '
         )
         FROM json_each(NEW.options_json)),
        ''
      )
  WHERE rowid = NEW.rowid;
END;

-- Keep tags in sync
CREATE TRIGGER question_tags_fts_ai AFTER INSERT ON question_tags BEGIN
  UPDATE questions_fts
  SET tags = COALESCE(
    (SELECT GROUP_CONCAT(tag, ' ')
     FROM question_tags
     WHERE question_id = NEW.question_id),
    ''
  )
  WHERE question_id = NEW.question_id;
END;

CREATE TRIGGER question_tags_fts_ad AFTER DELETE ON question_tags BEGIN
  UPDATE questions_fts
  SET tags = COALESCE(
    (SELECT GROUP_CONCAT(tag, ' ')
     FROM question_tags
     WHERE question_id = OLD.question_id),
    ''
  )
  WHERE question_id = OLD.question_id;
END;

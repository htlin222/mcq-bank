-- ============================================================
-- Migration 0046: CJK bigram channel for FTS5
--
-- unicode61 stores a continuous CJK run as one token, so 白血病 does not
-- match 慢性骨髓性白血病. Rebuild questions_fts, lecture_pages_fts,
-- lecture_notes_fts and smear_fts with an extra indexed `cjk` column of
-- overlapping bigrams. 0005 / 0016 / 0043 are already applied — not edited.
--
-- `cjk` is the LAST column on purpose: snippet() column indexes
-- (questions stem = 1, lecture page text = 2, lecture note content = 3)
-- stay valid. Do not insert a column in front of it.
--
-- The barrier is U+E000 (char(57344)), placed at the start of each CJK run.
-- An ASCII barrier would match every document on a prefix query like C*.
--
-- Questions and smear are small enough to backfill here. Lecture pages and
-- notes are not: one D1 HTTP request must finish in 30 seconds, and a single
-- INSERT of every page or note exceeds that. Those rows are filled by the
-- following 0047+ migrations. Apply the whole series; stopping after this
-- file leaves lecture search without mid-word matches.
-- ============================================================

CREATE TABLE cjk_digit (n INTEGER PRIMARY KEY);
INSERT INTO cjk_digit(n)
WITH RECURSIVE d(n) AS (
  SELECT 0
  UNION ALL
  SELECT n + 1 FROM d WHERE n < 9
)
SELECT n FROM d;
CREATE TABLE cjk_offsets (i INTEGER PRIMARY KEY);
INSERT INTO cjk_offsets(i)
SELECT d0.n + d1.n * 10 + d2.n * 100 + d3.n * 1000 + d4.n * 10000 + 1
FROM cjk_digit d0, cjk_digit d1, cjk_digit d2, cjk_digit d3, cjk_digit d4;

DROP TRIGGER IF EXISTS questions_fts_ai;
DROP TRIGGER IF EXISTS questions_fts_ad;
DROP TRIGGER IF EXISTS questions_fts_au;
DROP TRIGGER IF EXISTS question_tags_fts_ai;
DROP TRIGGER IF EXISTS question_tags_fts_ad;
DROP TABLE IF EXISTS questions_fts;

CREATE VIRTUAL TABLE questions_fts USING fts5(
  question_id UNINDEXED,
  stem,
  options,
  tags,
  cjk,
  tokenize = 'unicode61 remove_diacritics 2'
);

INSERT INTO questions_fts(rowid, question_id, stem, options, tags, cjk)
SELECT src.rowid, src.id, src.stem, src.options, src.tags, CASE WHEN length(CAST(src.text AS BLOB)) = length(src.text) THEN '' ELSE (SELECT COALESCE(group_concat(tok, ' ' ORDER BY i), '') FROM (
  SELECT i, CASE
      WHEN this_cjk AND next_cjk AND NOT prev_cjk
        THEN char(57344) || ' ' || gram
      WHEN this_cjk AND next_cjk THEN gram
      ELSE NULL
    END AS tok
  FROM (
    SELECT o.i AS i,
      ((substr(hx, o.i * 2 - 1, 1) = 'E' AND (substr(hx, o.i * 2 - 1, 6) BETWEEN 'E39080' AND 'E4B6BF' OR substr(hx, o.i * 2 - 1, 6) BETWEEN 'E4B880' AND 'E9BFBF' OR substr(hx, o.i * 2 - 1, 6) BETWEEN 'EFA480' AND 'EFABBF' OR substr(hx, o.i * 2 - 1, 6) BETWEEN 'E38181' AND 'E38296' OR substr(hx, o.i * 2 - 1, 6) BETWEEN 'E382A1' AND 'E383BA' OR substr(hx, o.i * 2 - 1, 6) BETWEEN 'E383BC' AND 'E383BC'))) AS this_cjk,
      ((substr(hx, o.i * 2 + 5, 1) = 'E' AND (substr(hx, o.i * 2 + 5, 6) BETWEEN 'E39080' AND 'E4B6BF' OR substr(hx, o.i * 2 + 5, 6) BETWEEN 'E4B880' AND 'E9BFBF' OR substr(hx, o.i * 2 + 5, 6) BETWEEN 'EFA480' AND 'EFABBF' OR substr(hx, o.i * 2 + 5, 6) BETWEEN 'E38181' AND 'E38296' OR substr(hx, o.i * 2 + 5, 6) BETWEEN 'E382A1' AND 'E383BA' OR substr(hx, o.i * 2 + 5, 6) BETWEEN 'E383BC' AND 'E383BC'))) AS next_cjk,
      (o.i >= 4 AND ((substr(hx, o.i * 2 - 7, 1) = 'E' AND (substr(hx, o.i * 2 - 7, 6) BETWEEN 'E39080' AND 'E4B6BF' OR substr(hx, o.i * 2 - 7, 6) BETWEEN 'E4B880' AND 'E9BFBF' OR substr(hx, o.i * 2 - 7, 6) BETWEEN 'EFA480' AND 'EFABBF' OR substr(hx, o.i * 2 - 7, 6) BETWEEN 'E38181' AND 'E38296' OR substr(hx, o.i * 2 - 7, 6) BETWEEN 'E382A1' AND 'E383BA' OR substr(hx, o.i * 2 - 7, 6) BETWEEN 'E383BC' AND 'E383BC')))) AS prev_cjk,
      CAST(substr(CAST(src.text AS BLOB), o.i, 6) AS TEXT) AS gram
    FROM (
      SELECT hex(CAST(src.text AS BLOB)) AS hx,
             length(CAST(src.text AS BLOB)) AS n
    ) enc
    JOIN cjk_offsets o ON o.i <= enc.n - 5
    WHERE substr(enc.hx, o.i * 2 - 1, 1) = 'E'
  )
) WHERE tok IS NOT NULL) END
FROM (
  SELECT q.rowid AS rowid, q.id AS id, q.stem AS stem,
    COALESCE((SELECT GROUP_CONCAT(COALESCE(json_extract(value, '$.key'), '') || '. ' || COALESCE(json_extract(value, '$.text'), ''), ' ') FROM json_each(q.options_json)), '') AS options,
    COALESCE((SELECT GROUP_CONCAT(tag, ' ') FROM question_tags WHERE question_id = q.id), '') AS tags,
    COALESCE(q.stem, '') || char(10) || COALESCE((SELECT GROUP_CONCAT(COALESCE(json_extract(value, '$.key'), '') || '. ' || COALESCE(json_extract(value, '$.text'), ''), ' ') FROM json_each(q.options_json)), '') || char(10) || COALESCE((SELECT GROUP_CONCAT(tag, ' ') FROM question_tags WHERE question_id = q.id), '') AS text
  FROM questions q
) src;

CREATE TRIGGER questions_fts_ai AFTER INSERT ON questions BEGIN
  INSERT INTO questions_fts(rowid, question_id, stem, options, tags, cjk)
  SELECT NEW.rowid, NEW.id, NEW.stem, src.options, '', CASE WHEN length(CAST(src.text AS BLOB)) = length(src.text) THEN '' ELSE (SELECT COALESCE(group_concat(tok, ' ' ORDER BY i), '') FROM (
  SELECT i, CASE
      WHEN this_cjk AND next_cjk AND NOT prev_cjk
        THEN char(57344) || ' ' || gram
      WHEN this_cjk AND next_cjk THEN gram
      ELSE NULL
    END AS tok
  FROM (
    SELECT o.i AS i,
      ((substr(hx, o.i * 2 - 1, 1) = 'E' AND (substr(hx, o.i * 2 - 1, 6) BETWEEN 'E39080' AND 'E4B6BF' OR substr(hx, o.i * 2 - 1, 6) BETWEEN 'E4B880' AND 'E9BFBF' OR substr(hx, o.i * 2 - 1, 6) BETWEEN 'EFA480' AND 'EFABBF' OR substr(hx, o.i * 2 - 1, 6) BETWEEN 'E38181' AND 'E38296' OR substr(hx, o.i * 2 - 1, 6) BETWEEN 'E382A1' AND 'E383BA' OR substr(hx, o.i * 2 - 1, 6) BETWEEN 'E383BC' AND 'E383BC'))) AS this_cjk,
      ((substr(hx, o.i * 2 + 5, 1) = 'E' AND (substr(hx, o.i * 2 + 5, 6) BETWEEN 'E39080' AND 'E4B6BF' OR substr(hx, o.i * 2 + 5, 6) BETWEEN 'E4B880' AND 'E9BFBF' OR substr(hx, o.i * 2 + 5, 6) BETWEEN 'EFA480' AND 'EFABBF' OR substr(hx, o.i * 2 + 5, 6) BETWEEN 'E38181' AND 'E38296' OR substr(hx, o.i * 2 + 5, 6) BETWEEN 'E382A1' AND 'E383BA' OR substr(hx, o.i * 2 + 5, 6) BETWEEN 'E383BC' AND 'E383BC'))) AS next_cjk,
      (o.i >= 4 AND ((substr(hx, o.i * 2 - 7, 1) = 'E' AND (substr(hx, o.i * 2 - 7, 6) BETWEEN 'E39080' AND 'E4B6BF' OR substr(hx, o.i * 2 - 7, 6) BETWEEN 'E4B880' AND 'E9BFBF' OR substr(hx, o.i * 2 - 7, 6) BETWEEN 'EFA480' AND 'EFABBF' OR substr(hx, o.i * 2 - 7, 6) BETWEEN 'E38181' AND 'E38296' OR substr(hx, o.i * 2 - 7, 6) BETWEEN 'E382A1' AND 'E383BA' OR substr(hx, o.i * 2 - 7, 6) BETWEEN 'E383BC' AND 'E383BC')))) AS prev_cjk,
      CAST(substr(CAST(src.text AS BLOB), o.i, 6) AS TEXT) AS gram
    FROM (
      SELECT hex(CAST(src.text AS BLOB)) AS hx,
             length(CAST(src.text AS BLOB)) AS n
    ) enc
    JOIN cjk_offsets o ON o.i <= enc.n - 5
    WHERE substr(enc.hx, o.i * 2 - 1, 1) = 'E'
  )
) WHERE tok IS NOT NULL) END
  FROM (
    SELECT COALESCE((SELECT GROUP_CONCAT(COALESCE(json_extract(value, '$.key'), '') || '. ' || COALESCE(json_extract(value, '$.text'), ''), ' ') FROM json_each(NEW.options_json)), '') AS options,
      COALESCE(NEW.stem, '') || char(10) || COALESCE((SELECT GROUP_CONCAT(COALESCE(json_extract(value, '$.key'), '') || '. ' || COALESCE(json_extract(value, '$.text'), ''), ' ') FROM json_each(NEW.options_json)), '') AS text
  ) src;
END;

CREATE TRIGGER questions_fts_ad AFTER DELETE ON questions BEGIN
  DELETE FROM questions_fts WHERE rowid = OLD.rowid;
END;

CREATE TRIGGER questions_fts_au AFTER UPDATE ON questions BEGIN
  UPDATE questions_fts
  SET stem = NEW.stem,
      options = COALESCE((SELECT GROUP_CONCAT(COALESCE(json_extract(value, '$.key'), '') || '. ' || COALESCE(json_extract(value, '$.text'), ''), ' ') FROM json_each(NEW.options_json)), ''),
      cjk = (
        SELECT CASE WHEN length(CAST(src.text AS BLOB)) = length(src.text) THEN '' ELSE (SELECT COALESCE(group_concat(tok, ' ' ORDER BY i), '') FROM (
  SELECT i, CASE
      WHEN this_cjk AND next_cjk AND NOT prev_cjk
        THEN char(57344) || ' ' || gram
      WHEN this_cjk AND next_cjk THEN gram
      ELSE NULL
    END AS tok
  FROM (
    SELECT o.i AS i,
      ((substr(hx, o.i * 2 - 1, 1) = 'E' AND (substr(hx, o.i * 2 - 1, 6) BETWEEN 'E39080' AND 'E4B6BF' OR substr(hx, o.i * 2 - 1, 6) BETWEEN 'E4B880' AND 'E9BFBF' OR substr(hx, o.i * 2 - 1, 6) BETWEEN 'EFA480' AND 'EFABBF' OR substr(hx, o.i * 2 - 1, 6) BETWEEN 'E38181' AND 'E38296' OR substr(hx, o.i * 2 - 1, 6) BETWEEN 'E382A1' AND 'E383BA' OR substr(hx, o.i * 2 - 1, 6) BETWEEN 'E383BC' AND 'E383BC'))) AS this_cjk,
      ((substr(hx, o.i * 2 + 5, 1) = 'E' AND (substr(hx, o.i * 2 + 5, 6) BETWEEN 'E39080' AND 'E4B6BF' OR substr(hx, o.i * 2 + 5, 6) BETWEEN 'E4B880' AND 'E9BFBF' OR substr(hx, o.i * 2 + 5, 6) BETWEEN 'EFA480' AND 'EFABBF' OR substr(hx, o.i * 2 + 5, 6) BETWEEN 'E38181' AND 'E38296' OR substr(hx, o.i * 2 + 5, 6) BETWEEN 'E382A1' AND 'E383BA' OR substr(hx, o.i * 2 + 5, 6) BETWEEN 'E383BC' AND 'E383BC'))) AS next_cjk,
      (o.i >= 4 AND ((substr(hx, o.i * 2 - 7, 1) = 'E' AND (substr(hx, o.i * 2 - 7, 6) BETWEEN 'E39080' AND 'E4B6BF' OR substr(hx, o.i * 2 - 7, 6) BETWEEN 'E4B880' AND 'E9BFBF' OR substr(hx, o.i * 2 - 7, 6) BETWEEN 'EFA480' AND 'EFABBF' OR substr(hx, o.i * 2 - 7, 6) BETWEEN 'E38181' AND 'E38296' OR substr(hx, o.i * 2 - 7, 6) BETWEEN 'E382A1' AND 'E383BA' OR substr(hx, o.i * 2 - 7, 6) BETWEEN 'E383BC' AND 'E383BC')))) AS prev_cjk,
      CAST(substr(CAST(src.text AS BLOB), o.i, 6) AS TEXT) AS gram
    FROM (
      SELECT hex(CAST(src.text AS BLOB)) AS hx,
             length(CAST(src.text AS BLOB)) AS n
    ) enc
    JOIN cjk_offsets o ON o.i <= enc.n - 5
    WHERE substr(enc.hx, o.i * 2 - 1, 1) = 'E'
  )
) WHERE tok IS NOT NULL) END
        FROM (
          SELECT COALESCE(NEW.stem, '') || char(10) || COALESCE((SELECT GROUP_CONCAT(COALESCE(json_extract(value, '$.key'), '') || '. ' || COALESCE(json_extract(value, '$.text'), ''), ' ') FROM json_each(NEW.options_json)), '') || char(10) || COALESCE((SELECT GROUP_CONCAT(tag, ' ') FROM question_tags WHERE question_id = NEW.id), '') AS text
        ) src
      )
  WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER question_tags_fts_ai AFTER INSERT ON question_tags BEGIN
  UPDATE questions_fts
  SET tags = COALESCE((SELECT GROUP_CONCAT(tag, ' ') FROM question_tags WHERE question_id = NEW.question_id), ''),
      cjk = (
        SELECT CASE WHEN length(CAST(src.text AS BLOB)) = length(src.text) THEN '' ELSE (SELECT COALESCE(group_concat(tok, ' ' ORDER BY i), '') FROM (
  SELECT i, CASE
      WHEN this_cjk AND next_cjk AND NOT prev_cjk
        THEN char(57344) || ' ' || gram
      WHEN this_cjk AND next_cjk THEN gram
      ELSE NULL
    END AS tok
  FROM (
    SELECT o.i AS i,
      ((substr(hx, o.i * 2 - 1, 1) = 'E' AND (substr(hx, o.i * 2 - 1, 6) BETWEEN 'E39080' AND 'E4B6BF' OR substr(hx, o.i * 2 - 1, 6) BETWEEN 'E4B880' AND 'E9BFBF' OR substr(hx, o.i * 2 - 1, 6) BETWEEN 'EFA480' AND 'EFABBF' OR substr(hx, o.i * 2 - 1, 6) BETWEEN 'E38181' AND 'E38296' OR substr(hx, o.i * 2 - 1, 6) BETWEEN 'E382A1' AND 'E383BA' OR substr(hx, o.i * 2 - 1, 6) BETWEEN 'E383BC' AND 'E383BC'))) AS this_cjk,
      ((substr(hx, o.i * 2 + 5, 1) = 'E' AND (substr(hx, o.i * 2 + 5, 6) BETWEEN 'E39080' AND 'E4B6BF' OR substr(hx, o.i * 2 + 5, 6) BETWEEN 'E4B880' AND 'E9BFBF' OR substr(hx, o.i * 2 + 5, 6) BETWEEN 'EFA480' AND 'EFABBF' OR substr(hx, o.i * 2 + 5, 6) BETWEEN 'E38181' AND 'E38296' OR substr(hx, o.i * 2 + 5, 6) BETWEEN 'E382A1' AND 'E383BA' OR substr(hx, o.i * 2 + 5, 6) BETWEEN 'E383BC' AND 'E383BC'))) AS next_cjk,
      (o.i >= 4 AND ((substr(hx, o.i * 2 - 7, 1) = 'E' AND (substr(hx, o.i * 2 - 7, 6) BETWEEN 'E39080' AND 'E4B6BF' OR substr(hx, o.i * 2 - 7, 6) BETWEEN 'E4B880' AND 'E9BFBF' OR substr(hx, o.i * 2 - 7, 6) BETWEEN 'EFA480' AND 'EFABBF' OR substr(hx, o.i * 2 - 7, 6) BETWEEN 'E38181' AND 'E38296' OR substr(hx, o.i * 2 - 7, 6) BETWEEN 'E382A1' AND 'E383BA' OR substr(hx, o.i * 2 - 7, 6) BETWEEN 'E383BC' AND 'E383BC')))) AS prev_cjk,
      CAST(substr(CAST(src.text AS BLOB), o.i, 6) AS TEXT) AS gram
    FROM (
      SELECT hex(CAST(src.text AS BLOB)) AS hx,
             length(CAST(src.text AS BLOB)) AS n
    ) enc
    JOIN cjk_offsets o ON o.i <= enc.n - 5
    WHERE substr(enc.hx, o.i * 2 - 1, 1) = 'E'
  )
) WHERE tok IS NOT NULL) END
        FROM (
          SELECT COALESCE(q.stem, '') || char(10) || COALESCE((SELECT GROUP_CONCAT(COALESCE(json_extract(value, '$.key'), '') || '. ' || COALESCE(json_extract(value, '$.text'), ''), ' ') FROM json_each(q.options_json)), '') || char(10) || COALESCE((SELECT GROUP_CONCAT(tag, ' ') FROM question_tags WHERE question_id = NEW.question_id), '') AS text
          FROM questions q
          WHERE q.id = NEW.question_id
        ) src
      )
  WHERE question_id = NEW.question_id;
END;

CREATE TRIGGER question_tags_fts_ad AFTER DELETE ON question_tags BEGIN
  UPDATE questions_fts
  SET tags = COALESCE((SELECT GROUP_CONCAT(tag, ' ') FROM question_tags WHERE question_id = OLD.question_id), ''),
      cjk = (
        SELECT CASE WHEN length(CAST(src.text AS BLOB)) = length(src.text) THEN '' ELSE (SELECT COALESCE(group_concat(tok, ' ' ORDER BY i), '') FROM (
  SELECT i, CASE
      WHEN this_cjk AND next_cjk AND NOT prev_cjk
        THEN char(57344) || ' ' || gram
      WHEN this_cjk AND next_cjk THEN gram
      ELSE NULL
    END AS tok
  FROM (
    SELECT o.i AS i,
      ((substr(hx, o.i * 2 - 1, 1) = 'E' AND (substr(hx, o.i * 2 - 1, 6) BETWEEN 'E39080' AND 'E4B6BF' OR substr(hx, o.i * 2 - 1, 6) BETWEEN 'E4B880' AND 'E9BFBF' OR substr(hx, o.i * 2 - 1, 6) BETWEEN 'EFA480' AND 'EFABBF' OR substr(hx, o.i * 2 - 1, 6) BETWEEN 'E38181' AND 'E38296' OR substr(hx, o.i * 2 - 1, 6) BETWEEN 'E382A1' AND 'E383BA' OR substr(hx, o.i * 2 - 1, 6) BETWEEN 'E383BC' AND 'E383BC'))) AS this_cjk,
      ((substr(hx, o.i * 2 + 5, 1) = 'E' AND (substr(hx, o.i * 2 + 5, 6) BETWEEN 'E39080' AND 'E4B6BF' OR substr(hx, o.i * 2 + 5, 6) BETWEEN 'E4B880' AND 'E9BFBF' OR substr(hx, o.i * 2 + 5, 6) BETWEEN 'EFA480' AND 'EFABBF' OR substr(hx, o.i * 2 + 5, 6) BETWEEN 'E38181' AND 'E38296' OR substr(hx, o.i * 2 + 5, 6) BETWEEN 'E382A1' AND 'E383BA' OR substr(hx, o.i * 2 + 5, 6) BETWEEN 'E383BC' AND 'E383BC'))) AS next_cjk,
      (o.i >= 4 AND ((substr(hx, o.i * 2 - 7, 1) = 'E' AND (substr(hx, o.i * 2 - 7, 6) BETWEEN 'E39080' AND 'E4B6BF' OR substr(hx, o.i * 2 - 7, 6) BETWEEN 'E4B880' AND 'E9BFBF' OR substr(hx, o.i * 2 - 7, 6) BETWEEN 'EFA480' AND 'EFABBF' OR substr(hx, o.i * 2 - 7, 6) BETWEEN 'E38181' AND 'E38296' OR substr(hx, o.i * 2 - 7, 6) BETWEEN 'E382A1' AND 'E383BA' OR substr(hx, o.i * 2 - 7, 6) BETWEEN 'E383BC' AND 'E383BC')))) AS prev_cjk,
      CAST(substr(CAST(src.text AS BLOB), o.i, 6) AS TEXT) AS gram
    FROM (
      SELECT hex(CAST(src.text AS BLOB)) AS hx,
             length(CAST(src.text AS BLOB)) AS n
    ) enc
    JOIN cjk_offsets o ON o.i <= enc.n - 5
    WHERE substr(enc.hx, o.i * 2 - 1, 1) = 'E'
  )
) WHERE tok IS NOT NULL) END
        FROM (
          SELECT COALESCE(q.stem, '') || char(10) || COALESCE((SELECT GROUP_CONCAT(COALESCE(json_extract(value, '$.key'), '') || '. ' || COALESCE(json_extract(value, '$.text'), ''), ' ') FROM json_each(q.options_json)), '') || char(10) || COALESCE((SELECT GROUP_CONCAT(tag, ' ') FROM question_tags WHERE question_id = OLD.question_id), '') AS text
          FROM questions q
          WHERE q.id = OLD.question_id
        ) src
      )
  WHERE question_id = OLD.question_id;
END;

DROP TRIGGER IF EXISTS lecture_pages_ai;
DROP TRIGGER IF EXISTS lecture_pages_ad;
DROP TRIGGER IF EXISTS lecture_pages_au;
DROP TABLE IF EXISTS lecture_pages_fts;

CREATE VIRTUAL TABLE lecture_pages_fts USING fts5(
  slug UNINDEXED,
  page UNINDEXED,
  text,
  cjk,
  tokenize = 'unicode61 remove_diacritics 2'
);

-- Pages are backfilled in later migrations (see cjkMigrationFiles).

CREATE TRIGGER lecture_pages_ai AFTER INSERT ON lecture_pages BEGIN
  INSERT INTO lecture_pages_fts(rowid, slug, page, text, cjk)
  SELECT NEW.rowid, NEW.slug, NEW.page, src.text, CASE WHEN length(CAST(src.text AS BLOB)) = length(src.text) THEN '' ELSE (SELECT COALESCE(group_concat(tok, ' ' ORDER BY i), '') FROM (
  SELECT i, CASE
      WHEN this_cjk AND next_cjk AND NOT prev_cjk
        THEN char(57344) || ' ' || gram
      WHEN this_cjk AND next_cjk THEN gram
      ELSE NULL
    END AS tok
  FROM (
    SELECT o.i AS i,
      ((substr(hx, o.i * 2 - 1, 1) = 'E' AND (substr(hx, o.i * 2 - 1, 6) BETWEEN 'E39080' AND 'E4B6BF' OR substr(hx, o.i * 2 - 1, 6) BETWEEN 'E4B880' AND 'E9BFBF' OR substr(hx, o.i * 2 - 1, 6) BETWEEN 'EFA480' AND 'EFABBF' OR substr(hx, o.i * 2 - 1, 6) BETWEEN 'E38181' AND 'E38296' OR substr(hx, o.i * 2 - 1, 6) BETWEEN 'E382A1' AND 'E383BA' OR substr(hx, o.i * 2 - 1, 6) BETWEEN 'E383BC' AND 'E383BC'))) AS this_cjk,
      ((substr(hx, o.i * 2 + 5, 1) = 'E' AND (substr(hx, o.i * 2 + 5, 6) BETWEEN 'E39080' AND 'E4B6BF' OR substr(hx, o.i * 2 + 5, 6) BETWEEN 'E4B880' AND 'E9BFBF' OR substr(hx, o.i * 2 + 5, 6) BETWEEN 'EFA480' AND 'EFABBF' OR substr(hx, o.i * 2 + 5, 6) BETWEEN 'E38181' AND 'E38296' OR substr(hx, o.i * 2 + 5, 6) BETWEEN 'E382A1' AND 'E383BA' OR substr(hx, o.i * 2 + 5, 6) BETWEEN 'E383BC' AND 'E383BC'))) AS next_cjk,
      (o.i >= 4 AND ((substr(hx, o.i * 2 - 7, 1) = 'E' AND (substr(hx, o.i * 2 - 7, 6) BETWEEN 'E39080' AND 'E4B6BF' OR substr(hx, o.i * 2 - 7, 6) BETWEEN 'E4B880' AND 'E9BFBF' OR substr(hx, o.i * 2 - 7, 6) BETWEEN 'EFA480' AND 'EFABBF' OR substr(hx, o.i * 2 - 7, 6) BETWEEN 'E38181' AND 'E38296' OR substr(hx, o.i * 2 - 7, 6) BETWEEN 'E382A1' AND 'E383BA' OR substr(hx, o.i * 2 - 7, 6) BETWEEN 'E383BC' AND 'E383BC')))) AS prev_cjk,
      CAST(substr(CAST(src.text AS BLOB), o.i, 6) AS TEXT) AS gram
    FROM (
      SELECT hex(CAST(src.text AS BLOB)) AS hx,
             length(CAST(src.text AS BLOB)) AS n
    ) enc
    JOIN cjk_offsets o ON o.i <= enc.n - 5
    WHERE substr(enc.hx, o.i * 2 - 1, 1) = 'E'
  )
) WHERE tok IS NOT NULL) END
  FROM (SELECT NEW.text AS text) src;
END;

CREATE TRIGGER lecture_pages_ad AFTER DELETE ON lecture_pages BEGIN
  DELETE FROM lecture_pages_fts WHERE rowid = OLD.rowid;
END;

CREATE TRIGGER lecture_pages_au AFTER UPDATE ON lecture_pages BEGIN
  DELETE FROM lecture_pages_fts WHERE rowid = OLD.rowid;
  INSERT INTO lecture_pages_fts(rowid, slug, page, text, cjk)
  SELECT NEW.rowid, NEW.slug, NEW.page, src.text, CASE WHEN length(CAST(src.text AS BLOB)) = length(src.text) THEN '' ELSE (SELECT COALESCE(group_concat(tok, ' ' ORDER BY i), '') FROM (
  SELECT i, CASE
      WHEN this_cjk AND next_cjk AND NOT prev_cjk
        THEN char(57344) || ' ' || gram
      WHEN this_cjk AND next_cjk THEN gram
      ELSE NULL
    END AS tok
  FROM (
    SELECT o.i AS i,
      ((substr(hx, o.i * 2 - 1, 1) = 'E' AND (substr(hx, o.i * 2 - 1, 6) BETWEEN 'E39080' AND 'E4B6BF' OR substr(hx, o.i * 2 - 1, 6) BETWEEN 'E4B880' AND 'E9BFBF' OR substr(hx, o.i * 2 - 1, 6) BETWEEN 'EFA480' AND 'EFABBF' OR substr(hx, o.i * 2 - 1, 6) BETWEEN 'E38181' AND 'E38296' OR substr(hx, o.i * 2 - 1, 6) BETWEEN 'E382A1' AND 'E383BA' OR substr(hx, o.i * 2 - 1, 6) BETWEEN 'E383BC' AND 'E383BC'))) AS this_cjk,
      ((substr(hx, o.i * 2 + 5, 1) = 'E' AND (substr(hx, o.i * 2 + 5, 6) BETWEEN 'E39080' AND 'E4B6BF' OR substr(hx, o.i * 2 + 5, 6) BETWEEN 'E4B880' AND 'E9BFBF' OR substr(hx, o.i * 2 + 5, 6) BETWEEN 'EFA480' AND 'EFABBF' OR substr(hx, o.i * 2 + 5, 6) BETWEEN 'E38181' AND 'E38296' OR substr(hx, o.i * 2 + 5, 6) BETWEEN 'E382A1' AND 'E383BA' OR substr(hx, o.i * 2 + 5, 6) BETWEEN 'E383BC' AND 'E383BC'))) AS next_cjk,
      (o.i >= 4 AND ((substr(hx, o.i * 2 - 7, 1) = 'E' AND (substr(hx, o.i * 2 - 7, 6) BETWEEN 'E39080' AND 'E4B6BF' OR substr(hx, o.i * 2 - 7, 6) BETWEEN 'E4B880' AND 'E9BFBF' OR substr(hx, o.i * 2 - 7, 6) BETWEEN 'EFA480' AND 'EFABBF' OR substr(hx, o.i * 2 - 7, 6) BETWEEN 'E38181' AND 'E38296' OR substr(hx, o.i * 2 - 7, 6) BETWEEN 'E382A1' AND 'E383BA' OR substr(hx, o.i * 2 - 7, 6) BETWEEN 'E383BC' AND 'E383BC')))) AS prev_cjk,
      CAST(substr(CAST(src.text AS BLOB), o.i, 6) AS TEXT) AS gram
    FROM (
      SELECT hex(CAST(src.text AS BLOB)) AS hx,
             length(CAST(src.text AS BLOB)) AS n
    ) enc
    JOIN cjk_offsets o ON o.i <= enc.n - 5
    WHERE substr(enc.hx, o.i * 2 - 1, 1) = 'E'
  )
) WHERE tok IS NOT NULL) END
  FROM (SELECT NEW.text AS text) src;
END;

DROP TRIGGER IF EXISTS lecture_notes_ai;
DROP TRIGGER IF EXISTS lecture_notes_ad;
DROP TRIGGER IF EXISTS lecture_notes_au;
DROP TABLE IF EXISTS lecture_notes_fts;

CREATE VIRTUAL TABLE lecture_notes_fts USING fts5(
  user_email UNINDEXED,
  slug UNINDEXED,
  page UNINDEXED,
  content,
  cjk,
  tokenize = 'unicode61 remove_diacritics 2'
);

-- Notes are backfilled in later migrations (see cjkMigrationFiles).

CREATE TRIGGER lecture_notes_ai AFTER INSERT ON lecture_notes BEGIN
  INSERT INTO lecture_notes_fts(rowid, user_email, slug, page, content, cjk)
  SELECT NEW.rowid, NEW.user_email, NEW.slug, NEW.page, src.content, CASE WHEN length(CAST(src.content AS BLOB)) = length(src.content) THEN '' ELSE (SELECT COALESCE(group_concat(tok, ' ' ORDER BY i), '') FROM (
  SELECT i, CASE
      WHEN this_cjk AND next_cjk AND NOT prev_cjk
        THEN char(57344) || ' ' || gram
      WHEN this_cjk AND next_cjk THEN gram
      ELSE NULL
    END AS tok
  FROM (
    SELECT o.i AS i,
      ((substr(hx, o.i * 2 - 1, 1) = 'E' AND (substr(hx, o.i * 2 - 1, 6) BETWEEN 'E39080' AND 'E4B6BF' OR substr(hx, o.i * 2 - 1, 6) BETWEEN 'E4B880' AND 'E9BFBF' OR substr(hx, o.i * 2 - 1, 6) BETWEEN 'EFA480' AND 'EFABBF' OR substr(hx, o.i * 2 - 1, 6) BETWEEN 'E38181' AND 'E38296' OR substr(hx, o.i * 2 - 1, 6) BETWEEN 'E382A1' AND 'E383BA' OR substr(hx, o.i * 2 - 1, 6) BETWEEN 'E383BC' AND 'E383BC'))) AS this_cjk,
      ((substr(hx, o.i * 2 + 5, 1) = 'E' AND (substr(hx, o.i * 2 + 5, 6) BETWEEN 'E39080' AND 'E4B6BF' OR substr(hx, o.i * 2 + 5, 6) BETWEEN 'E4B880' AND 'E9BFBF' OR substr(hx, o.i * 2 + 5, 6) BETWEEN 'EFA480' AND 'EFABBF' OR substr(hx, o.i * 2 + 5, 6) BETWEEN 'E38181' AND 'E38296' OR substr(hx, o.i * 2 + 5, 6) BETWEEN 'E382A1' AND 'E383BA' OR substr(hx, o.i * 2 + 5, 6) BETWEEN 'E383BC' AND 'E383BC'))) AS next_cjk,
      (o.i >= 4 AND ((substr(hx, o.i * 2 - 7, 1) = 'E' AND (substr(hx, o.i * 2 - 7, 6) BETWEEN 'E39080' AND 'E4B6BF' OR substr(hx, o.i * 2 - 7, 6) BETWEEN 'E4B880' AND 'E9BFBF' OR substr(hx, o.i * 2 - 7, 6) BETWEEN 'EFA480' AND 'EFABBF' OR substr(hx, o.i * 2 - 7, 6) BETWEEN 'E38181' AND 'E38296' OR substr(hx, o.i * 2 - 7, 6) BETWEEN 'E382A1' AND 'E383BA' OR substr(hx, o.i * 2 - 7, 6) BETWEEN 'E383BC' AND 'E383BC')))) AS prev_cjk,
      CAST(substr(CAST(src.content AS BLOB), o.i, 6) AS TEXT) AS gram
    FROM (
      SELECT hex(CAST(src.content AS BLOB)) AS hx,
             length(CAST(src.content AS BLOB)) AS n
    ) enc
    JOIN cjk_offsets o ON o.i <= enc.n - 5
    WHERE substr(enc.hx, o.i * 2 - 1, 1) = 'E'
  )
) WHERE tok IS NOT NULL) END
  FROM (SELECT COALESCE((SELECT GROUP_CONCAT(value, ' ') FROM json_tree(NEW.content_json) WHERE key = 'text' AND type = 'text'), '') AS content) src;
END;

CREATE TRIGGER lecture_notes_ad AFTER DELETE ON lecture_notes BEGIN
  DELETE FROM lecture_notes_fts WHERE rowid = OLD.rowid;
END;

CREATE TRIGGER lecture_notes_au AFTER UPDATE ON lecture_notes BEGIN
  DELETE FROM lecture_notes_fts WHERE rowid = OLD.rowid;
  INSERT INTO lecture_notes_fts(rowid, user_email, slug, page, content, cjk)
  SELECT NEW.rowid, NEW.user_email, NEW.slug, NEW.page, src.content, CASE WHEN length(CAST(src.content AS BLOB)) = length(src.content) THEN '' ELSE (SELECT COALESCE(group_concat(tok, ' ' ORDER BY i), '') FROM (
  SELECT i, CASE
      WHEN this_cjk AND next_cjk AND NOT prev_cjk
        THEN char(57344) || ' ' || gram
      WHEN this_cjk AND next_cjk THEN gram
      ELSE NULL
    END AS tok
  FROM (
    SELECT o.i AS i,
      ((substr(hx, o.i * 2 - 1, 1) = 'E' AND (substr(hx, o.i * 2 - 1, 6) BETWEEN 'E39080' AND 'E4B6BF' OR substr(hx, o.i * 2 - 1, 6) BETWEEN 'E4B880' AND 'E9BFBF' OR substr(hx, o.i * 2 - 1, 6) BETWEEN 'EFA480' AND 'EFABBF' OR substr(hx, o.i * 2 - 1, 6) BETWEEN 'E38181' AND 'E38296' OR substr(hx, o.i * 2 - 1, 6) BETWEEN 'E382A1' AND 'E383BA' OR substr(hx, o.i * 2 - 1, 6) BETWEEN 'E383BC' AND 'E383BC'))) AS this_cjk,
      ((substr(hx, o.i * 2 + 5, 1) = 'E' AND (substr(hx, o.i * 2 + 5, 6) BETWEEN 'E39080' AND 'E4B6BF' OR substr(hx, o.i * 2 + 5, 6) BETWEEN 'E4B880' AND 'E9BFBF' OR substr(hx, o.i * 2 + 5, 6) BETWEEN 'EFA480' AND 'EFABBF' OR substr(hx, o.i * 2 + 5, 6) BETWEEN 'E38181' AND 'E38296' OR substr(hx, o.i * 2 + 5, 6) BETWEEN 'E382A1' AND 'E383BA' OR substr(hx, o.i * 2 + 5, 6) BETWEEN 'E383BC' AND 'E383BC'))) AS next_cjk,
      (o.i >= 4 AND ((substr(hx, o.i * 2 - 7, 1) = 'E' AND (substr(hx, o.i * 2 - 7, 6) BETWEEN 'E39080' AND 'E4B6BF' OR substr(hx, o.i * 2 - 7, 6) BETWEEN 'E4B880' AND 'E9BFBF' OR substr(hx, o.i * 2 - 7, 6) BETWEEN 'EFA480' AND 'EFABBF' OR substr(hx, o.i * 2 - 7, 6) BETWEEN 'E38181' AND 'E38296' OR substr(hx, o.i * 2 - 7, 6) BETWEEN 'E382A1' AND 'E383BA' OR substr(hx, o.i * 2 - 7, 6) BETWEEN 'E383BC' AND 'E383BC')))) AS prev_cjk,
      CAST(substr(CAST(src.content AS BLOB), o.i, 6) AS TEXT) AS gram
    FROM (
      SELECT hex(CAST(src.content AS BLOB)) AS hx,
             length(CAST(src.content AS BLOB)) AS n
    ) enc
    JOIN cjk_offsets o ON o.i <= enc.n - 5
    WHERE substr(enc.hx, o.i * 2 - 1, 1) = 'E'
  )
) WHERE tok IS NOT NULL) END
  FROM (SELECT COALESCE((SELECT GROUP_CONCAT(value, ' ') FROM json_tree(NEW.content_json) WHERE key = 'text' AND type = 'text'), '') AS content) src;
END;

DROP TABLE IF EXISTS smear_fts;

CREATE VIRTUAL TABLE smear_fts USING fts5(
  dx_id UNINDEXED,
  canonical,
  terms,
  topic,
  note,
  cjk,
  tokenize = 'unicode61'
);

INSERT INTO smear_fts (dx_id, canonical, terms, topic, note, cjk)
SELECT src.id, src.canonical, src.terms, src.topic, src.note, CASE WHEN length(CAST(src.text AS BLOB)) = length(src.text) THEN '' ELSE (SELECT COALESCE(group_concat(tok, ' ' ORDER BY i), '') FROM (
  SELECT i, CASE
      WHEN this_cjk AND next_cjk AND NOT prev_cjk
        THEN char(57344) || ' ' || gram
      WHEN this_cjk AND next_cjk THEN gram
      ELSE NULL
    END AS tok
  FROM (
    SELECT o.i AS i,
      ((substr(hx, o.i * 2 - 1, 1) = 'E' AND (substr(hx, o.i * 2 - 1, 6) BETWEEN 'E39080' AND 'E4B6BF' OR substr(hx, o.i * 2 - 1, 6) BETWEEN 'E4B880' AND 'E9BFBF' OR substr(hx, o.i * 2 - 1, 6) BETWEEN 'EFA480' AND 'EFABBF' OR substr(hx, o.i * 2 - 1, 6) BETWEEN 'E38181' AND 'E38296' OR substr(hx, o.i * 2 - 1, 6) BETWEEN 'E382A1' AND 'E383BA' OR substr(hx, o.i * 2 - 1, 6) BETWEEN 'E383BC' AND 'E383BC'))) AS this_cjk,
      ((substr(hx, o.i * 2 + 5, 1) = 'E' AND (substr(hx, o.i * 2 + 5, 6) BETWEEN 'E39080' AND 'E4B6BF' OR substr(hx, o.i * 2 + 5, 6) BETWEEN 'E4B880' AND 'E9BFBF' OR substr(hx, o.i * 2 + 5, 6) BETWEEN 'EFA480' AND 'EFABBF' OR substr(hx, o.i * 2 + 5, 6) BETWEEN 'E38181' AND 'E38296' OR substr(hx, o.i * 2 + 5, 6) BETWEEN 'E382A1' AND 'E383BA' OR substr(hx, o.i * 2 + 5, 6) BETWEEN 'E383BC' AND 'E383BC'))) AS next_cjk,
      (o.i >= 4 AND ((substr(hx, o.i * 2 - 7, 1) = 'E' AND (substr(hx, o.i * 2 - 7, 6) BETWEEN 'E39080' AND 'E4B6BF' OR substr(hx, o.i * 2 - 7, 6) BETWEEN 'E4B880' AND 'E9BFBF' OR substr(hx, o.i * 2 - 7, 6) BETWEEN 'EFA480' AND 'EFABBF' OR substr(hx, o.i * 2 - 7, 6) BETWEEN 'E38181' AND 'E38296' OR substr(hx, o.i * 2 - 7, 6) BETWEEN 'E382A1' AND 'E383BA' OR substr(hx, o.i * 2 - 7, 6) BETWEEN 'E383BC' AND 'E383BC')))) AS prev_cjk,
      CAST(substr(CAST(src.text AS BLOB), o.i, 6) AS TEXT) AS gram
    FROM (
      SELECT hex(CAST(src.text AS BLOB)) AS hx,
             length(CAST(src.text AS BLOB)) AS n
    ) enc
    JOIN cjk_offsets o ON o.i <= enc.n - 5
    WHERE substr(enc.hx, o.i * 2 - 1, 1) = 'E'
  )
) WHERE tok IS NOT NULL) END
FROM (
  SELECT id, canonical, terms, topic, note,
    canonical || char(10) || terms || char(10) || COALESCE(topic, '') || char(10) || note AS text
  FROM (
    SELECT d.id AS id,
      TRIM(d.canonical_long || ' ' || COALESCE(d.canonical_abbrev, '')) AS canonical,
      COALESCE((SELECT group_concat(t.text, ' ') FROM smear_terms t WHERE t.dx_id = d.id AND t.status = 'accepted'), '') AS terms,
      d.topic AS topic,
      COALESCE((SELECT group_concat(jt.value, ' ') FROM smear_dx_notes n, json_tree(n.content_json) jt WHERE n.dx_id = d.id AND jt.key = 'text' AND jt.type = 'text'), '') AS note
    FROM smear_dx d
  )
) src;

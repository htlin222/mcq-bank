-- lecture_notes rowid > 42000 AND rowid <= 44000
-- Split out of 0046 so this request stays under D1's 30 second limit.
DELETE FROM lecture_notes_fts WHERE rowid > 42000 AND rowid <= 44000;
INSERT INTO lecture_notes_fts(rowid, user_email, slug, page, content, cjk)
SELECT src.rowid, src.user_email, src.slug, src.page, src.content, CASE WHEN length(CAST(src.content AS BLOB)) = length(src.content) THEN '' ELSE (SELECT COALESCE(group_concat(tok, ' ' ORDER BY i), '') FROM (
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
FROM (
  SELECT n.rowid AS rowid, n.user_email AS user_email, n.slug AS slug, n.page AS page,
    COALESCE((SELECT GROUP_CONCAT(value, ' ') FROM json_tree(n.content_json) WHERE key = 'text' AND type = 'text'), '') AS content
  FROM lecture_notes n
  WHERE rowid > 42000 AND rowid <= 44000
) src;

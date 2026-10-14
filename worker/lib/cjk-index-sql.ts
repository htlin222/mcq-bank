/**
 * CJK bigram 欄的 SQL。查詢側在 `fts-query.ts`。
 *
 * unicode61 把連續 CJK 收成一個 token,所以索引裡另外存重疊的二字
 * (`慢性骨髓性白血病` → `慢性 性骨 骨髓 髓性 性白 白血 血病`)。
 * 兩段 CJK 中間插 U+E000(`char(57344)`):它是一個 token,片語跨不過去,
 * 也不會被 `C*` 這種 ASCII 前綴掃到。用英文字當屏障的話,每個文件都命中 `C*`。
 *
 * 字界跟 `CJK_RANGES` 同一份,但走 UTF-8 位元組,不走 `substr(text, i, 1)`。
 * 後者每取一個字都要從字串開頭數過來,整頁是平方。講義頁實測 400 頁要
 * 77 秒,44,000 則筆記塞不進 D1 單次請求的 30 秒上限。
 *
 * 屏障放在每一段的開頭(不是結尾)。片語要的是「段內相鄰」,開頭多一顆
 * token 不會拆開段內的二字;段與段之間仍然隔著它。
 *
 * 位數表用深度 10 的遞迴,不用十段 `UNION ALL`:D1 的
 * `SQLITE_MAX_COMPOUND_SELECT` 比 10 小,十段複合查詢直接被拒。
 * 五份位數表交叉聯結不是複合查詢。
 */
import { CJK_RANGES } from "./fts-query.ts";

/** U+E000. unicode61 會把它編成一個 token,ASCII 前綴對不到。 */
export const CJK_BARRIER_SQL = "char(57344)";

/** U+0800–U+FFFF 的 UTF-8 三碼。`CJK_RANGES` 全都落在這段。 */
export function cjkUtf8Hex(cp: number): string {
	const b0 = 0xe0 | (cp >> 12);
	const b1 = 0x80 | ((cp >> 6) & 0x3f);
	const b2 = 0x80 | (cp & 0x3f);
	return [b0, b1, b2]
		.map((b) => b.toString(16).toUpperCase().padStart(2, "0"))
		.join("");
}

/** `hexPos` 是 `hex(blob)` 裡的 1-based 起點,指向一個位元組。 */
function cjkAtHex(hexPos: string): string {
	const ranges = CJK_RANGES.map(
		([a, b]) =>
			`substr(hx, ${hexPos}, 6) BETWEEN '${cjkUtf8Hex(a)}' AND '${cjkUtf8Hex(b)}'`,
	).join(" OR ");
	return `(substr(hx, ${hexPos}, 1) = 'E' AND (${ranges}))`;
}

/**
 * 純量子查詢,產生 `textExpr` 的 bigram 字串。
 * `textExpr` 必須是外層已經算好的欄位(例如 `src.text`),不要把
 * `json_each` 直接塞進來 —— hex 會重跑。
 *
 * 純 ASCII 直接回空字串,連偏移表都不碰。
 */
export function cjkBigramSql(textExpr: string): string {
	const atI = cjkAtHex("o.i * 2 - 1");
	const atNext = cjkAtHex("o.i * 2 + 5");
	const atPrev = cjkAtHex("o.i * 2 - 7");
	const scan = `(SELECT COALESCE(group_concat(tok, ' ' ORDER BY i), '') FROM (
  SELECT i, CASE
      WHEN this_cjk AND next_cjk AND NOT prev_cjk
        THEN ${CJK_BARRIER_SQL} || ' ' || gram
      WHEN this_cjk AND next_cjk THEN gram
      ELSE NULL
    END AS tok
  FROM (
    SELECT o.i AS i,
      (${atI}) AS this_cjk,
      (${atNext}) AS next_cjk,
      (o.i >= 4 AND (${atPrev})) AS prev_cjk,
      CAST(substr(CAST(${textExpr} AS BLOB), o.i, 6) AS TEXT) AS gram
    FROM (
      SELECT hex(CAST(${textExpr} AS BLOB)) AS hx,
             length(CAST(${textExpr} AS BLOB)) AS n
    ) enc
    JOIN cjk_offsets o ON o.i <= enc.n - 5
    WHERE substr(enc.hx, o.i * 2 - 1, 1) = 'E'
  )
) WHERE tok IS NOT NULL)`;
	return `CASE WHEN length(CAST(${textExpr} AS BLOB)) = length(${textExpr}) THEN '' ELSE ${scan} END`;
}

/**
 * 1..100000。一頁講義用不到這麼多字;超過的尾巴不進 bigram。
 * `cjk_digit` 只有 0..9,複合查詢只有兩段,D1 收得下。
 */
export function cjkOffsetsSql(): string {
	return `CREATE TABLE cjk_digit (n INTEGER PRIMARY KEY);
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
FROM cjk_digit d0, cjk_digit d1, cjk_digit d2, cjk_digit d3, cjk_digit d4;`;
}

function questionOptionsSql(optionsJsonExpr: string): string {
	return `COALESCE((SELECT GROUP_CONCAT(COALESCE(json_extract(value, '$.key'), '') || '. ' || COALESCE(json_extract(value, '$.text'), ''), ' ') FROM json_each(${optionsJsonExpr})), '')`;
}

function questionTagsSql(idExpr: string): string {
	return `COALESCE((SELECT GROUP_CONCAT(tag, ' ') FROM question_tags WHERE question_id = ${idExpr}), '')`;
}

function noteTextSql(jsonExpr: string): string {
	return `COALESCE((SELECT GROUP_CONCAT(value, ' ') FROM json_tree(${jsonExpr}) WHERE key = 'text' AND type = 'text'), '')`;
}

/** 抹片匯入與 migration 共用這一段,避免下次重灌把 `cjk` 留空。 */
export function smearFtsInsertSql(): string {
	const bigram = cjkBigramSql("src.text");
	return `INSERT INTO smear_fts (dx_id, canonical, terms, topic, note, cjk)
SELECT src.id, src.canonical, src.terms, src.topic, src.note, ${bigram}
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
) src;`;
}

/**
 * migration 0046 的全文。磁碟上的 `.sql` 必須跟這支的輸出一致
 * (`cjk-fts.test.ts` 釘著),否則查詢側與索引側會靜靜分叉。
 */
export function migration0046(): string {
	const bigram = cjkBigramSql("src.text");
	const noteBigram = cjkBigramSql("src.content");
	const optNew = questionOptionsSql("NEW.options_json");
	const optQ = questionOptionsSql("q.options_json");
	const tagsNew = questionTagsSql("NEW.id");
	const tagsQ = questionTagsSql("q.id");
	const tagsIns = questionTagsSql("NEW.question_id");
	const tagsOld = questionTagsSql("OLD.question_id");
	const noteNew = noteTextSql("NEW.content_json");

	return `-- ============================================================
-- Migration 0046: CJK bigram channel for FTS5
--
-- unicode61 stores a continuous CJK run as one token, so 白血病 does not
-- match 慢性骨髓性白血病. Rebuild questions_fts, lecture_pages_fts,
-- lecture_notes_fts and smear_fts with an extra indexed \`cjk\` column of
-- overlapping bigrams. 0005 / 0016 / 0043 are already applied — not edited.
--
-- \`cjk\` is the LAST column on purpose: snippet() column indexes
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

${cjkOffsetsSql()}

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
SELECT src.rowid, src.id, src.stem, src.options, src.tags, ${bigram}
FROM (
  SELECT q.rowid AS rowid, q.id AS id, q.stem AS stem,
    ${optQ} AS options,
    ${tagsQ} AS tags,
    COALESCE(q.stem, '') || char(10) || ${optQ} || char(10) || ${tagsQ} AS text
  FROM questions q
) src;

CREATE TRIGGER questions_fts_ai AFTER INSERT ON questions BEGIN
  INSERT INTO questions_fts(rowid, question_id, stem, options, tags, cjk)
  SELECT NEW.rowid, NEW.id, NEW.stem, src.options, '', ${bigram}
  FROM (
    SELECT ${optNew} AS options,
      COALESCE(NEW.stem, '') || char(10) || ${optNew} AS text
  ) src;
END;

CREATE TRIGGER questions_fts_ad AFTER DELETE ON questions BEGIN
  DELETE FROM questions_fts WHERE rowid = OLD.rowid;
END;

CREATE TRIGGER questions_fts_au AFTER UPDATE ON questions BEGIN
  UPDATE questions_fts
  SET stem = NEW.stem,
      options = ${optNew},
      cjk = (
        SELECT ${bigram}
        FROM (
          SELECT COALESCE(NEW.stem, '') || char(10) || ${optNew} || char(10) || ${tagsNew} AS text
        ) src
      )
  WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER question_tags_fts_ai AFTER INSERT ON question_tags BEGIN
  UPDATE questions_fts
  SET tags = ${tagsIns},
      cjk = (
        SELECT ${bigram}
        FROM (
          SELECT COALESCE(q.stem, '') || char(10) || ${optQ} || char(10) || ${tagsIns} AS text
          FROM questions q
          WHERE q.id = NEW.question_id
        ) src
      )
  WHERE question_id = NEW.question_id;
END;

CREATE TRIGGER question_tags_fts_ad AFTER DELETE ON question_tags BEGIN
  UPDATE questions_fts
  SET tags = ${tagsOld},
      cjk = (
        SELECT ${bigram}
        FROM (
          SELECT COALESCE(q.stem, '') || char(10) || ${optQ} || char(10) || ${tagsOld} AS text
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
  SELECT NEW.rowid, NEW.slug, NEW.page, src.text, ${bigram}
  FROM (SELECT NEW.text AS text) src;
END;

CREATE TRIGGER lecture_pages_ad AFTER DELETE ON lecture_pages BEGIN
  DELETE FROM lecture_pages_fts WHERE rowid = OLD.rowid;
END;

CREATE TRIGGER lecture_pages_au AFTER UPDATE ON lecture_pages BEGIN
  DELETE FROM lecture_pages_fts WHERE rowid = OLD.rowid;
  INSERT INTO lecture_pages_fts(rowid, slug, page, text, cjk)
  SELECT NEW.rowid, NEW.slug, NEW.page, src.text, ${bigram}
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
  SELECT NEW.rowid, NEW.user_email, NEW.slug, NEW.page, src.content, ${noteBigram}
  FROM (SELECT ${noteNew} AS content) src;
END;

CREATE TRIGGER lecture_notes_ad AFTER DELETE ON lecture_notes BEGIN
  DELETE FROM lecture_notes_fts WHERE rowid = OLD.rowid;
END;

CREATE TRIGGER lecture_notes_au AFTER UPDATE ON lecture_notes BEGIN
  DELETE FROM lecture_notes_fts WHERE rowid = OLD.rowid;
  INSERT INTO lecture_notes_fts(rowid, user_email, slug, page, content, cjk)
  SELECT NEW.rowid, NEW.user_email, NEW.slug, NEW.page, src.content, ${noteBigram}
  FROM (SELECT ${noteNew} AS content) src;
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

${smearFtsInsertSql()}
`;
}

/**
 * 講義頁與筆記的回填。D1 一次 HTTP 請求要在 30 秒內結束,而整表塞進
 * 一份 migration 會超時(sqlite 3.51 量過:5000 頁 14 秒、3000 則筆記 15 秒)。
 * 每份只做一段 rowid。不要併回去。
 *
 * 本機列號是連續的(頁 1..9496、筆記 1..43958)。最後一段沒有上界,
 * 套用當下比這段起點還大的列都會進去。
 */
export function cjkMigrationFiles(): { name: string; sql: string }[] {
	const files: { name: string; sql: string }[] = [
		{ name: "0046_cjk_bigram_fts.sql", sql: migration0046() },
	];
	let n = 47;
	const push = (kind: string, lo: number, sql: string) => {
		files.push({
			name: `${String(n).padStart(4, "0")}_cjk_bigram_${kind}_${String(lo).padStart(5, "0")}.sql`,
			sql,
		});
		n += 1;
	};
	for (let lo = 0; lo < 9000; lo += 3000) push("pages", lo, pageBackfillSql(lo, lo + 3000));
	push("pages", 9000, pageBackfillSql(9000, null));
	for (let lo = 0; lo < 44000; lo += 2000) push("notes", lo, noteBackfillSql(lo, lo + 2000));
	push("notes", 44000, noteBackfillSql(44000, null));
	return files;
}

function rowidWhere(lo: number, hi: number | null): string {
	return hi === null ? `rowid > ${lo}` : `rowid > ${lo} AND rowid <= ${hi}`;
}

function pageBackfillSql(lo: number, hi: number | null): string {
	const where = rowidWhere(lo, hi);
	const bigram = cjkBigramSql("src.text");
	return `-- lecture_pages ${where}
-- Split out of 0046 so this request stays under D1's 30 second limit.
DELETE FROM lecture_pages_fts WHERE ${where};
INSERT INTO lecture_pages_fts(rowid, slug, page, text, cjk)
SELECT src.rowid, src.slug, src.page, src.text, ${bigram}
FROM (
  SELECT rowid, slug, page, text FROM lecture_pages
  WHERE ${where}
) src;
`;
}

function noteBackfillSql(lo: number, hi: number | null): string {
	const where = rowidWhere(lo, hi);
	const bigram = cjkBigramSql("src.content");
	const content = noteTextSql("n.content_json");
	return `-- lecture_notes ${where}
-- Split out of 0046 so this request stays under D1's 30 second limit.
DELETE FROM lecture_notes_fts WHERE ${where};
INSERT INTO lecture_notes_fts(rowid, user_email, slug, page, content, cjk)
SELECT src.rowid, src.user_email, src.slug, src.page, src.content, ${bigram}
FROM (
  SELECT n.rowid AS rowid, n.user_email AS user_email, n.slug AS slug, n.page AS page,
    ${content} AS content
  FROM lecture_notes n
  WHERE ${where}
) src;
`;
}

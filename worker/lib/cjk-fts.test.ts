/**
 * 中文中段找得到,靠的是索引裡的二字,不是把查詢字串猜對。
 * 這支把 migration 0046 整份跑在 sqlite3 上:回填與 trigger 兩條路都要命中,
 * 而且屏障不能讓 `c*` 掃到每一列。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CJK_RANGES, ftsPhraseToken, ftsQuery } from "./fts-query.ts";
import { cjkMigrationFiles, cjkUtf8Hex } from "./cjk-index-sql.ts";

const SCHEMA = `
CREATE TABLE questions (
  id TEXT PRIMARY KEY,
  stem TEXT NOT NULL,
  options_json TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE question_tags (question_id TEXT, tag TEXT);
CREATE TABLE lecture_pages (slug TEXT, page INTEGER, text TEXT);
CREATE TABLE lecture_notes (
  user_email TEXT, slug TEXT, page INTEGER, content_json TEXT
);
CREATE TABLE smear_dx (
  id TEXT PRIMARY KEY,
  canonical_long TEXT,
  canonical_abbrev TEXT,
  topic TEXT
);
CREATE TABLE smear_terms (dx_id TEXT, text TEXT, status TEXT);
CREATE TABLE smear_dx_notes (dx_id TEXT, content_json TEXT);
`;

function sqlite(db: string, sql: string): string {
	return execFileSync("sqlite3", ["-cmd", ".bail on", db], {
		input: sql,
		encoding: "utf8",
	});
}

function ids(db: string, table: string, expr: string): string[] {
	const escaped = expr.replace(/'/g, "''");
	const out = sqlite(
		db,
		`SELECT question_id FROM ${table} WHERE ${table} MATCH '${escaped}' ORDER BY question_id;`,
	);
	return out
		.split("\n")
		.map((s) => s.trim())
		.filter(Boolean);
}

test("UTF-8 界線涵蓋 CJK_RANGES,而且都是三碼", () => {
	for (const [a, b] of CJK_RANGES) {
		assert.ok(a >= 0x800 && b <= 0xffff);
		assert.equal(cjkUtf8Hex(a).length, 6);
		assert.equal(cjkUtf8Hex(b).length, 6);
	}
	assert.equal(cjkUtf8Hex(0x4e00), "E4B880");
	assert.equal(cjkUtf8Hex(0x9fff), "E9BFBF");
	assert.equal(cjkUtf8Hex(0x30a1), "E382A1");
	assert.equal(cjkUtf8Hex(0x30fc), "E383BC");
});

test("磁碟上的 bigram migration 跟產生器同一份", () => {
	const files = cjkMigrationFiles();
	const disk = readdirSync("migrations").filter((name) => name.includes("cjk_bigram"));
	assert.deepEqual(disk.sort(), files.map((f) => f.name).sort());
	for (const f of files) {
		assert.equal(readFileSync(`migrations/${f.name}`, "utf8").trim(), f.sql.trim());
	}
});

test("白血病找得到慢性骨髓性白血病,英數前綴與片語還在", () => {
	const dir = mkdtempSync(join(tmpdir(), "cjk-fts-"));
	const db = join(dir, "t.sqlite");
	try {
		sqlite(
			db,
			SCHEMA +
				`
INSERT INTO questions (id, stem, options_json) VALUES
  ('q1', '慢性骨髓性白血病', '[]'),
  ('q5', '白血病，血小板減少', '[]');
INSERT INTO lecture_pages (slug, page, text) VALUES
  ('lec', 1, '本章討論慢性骨髓性白血病的治療');
INSERT INTO lecture_notes (user_email, slug, page, content_json) VALUES
  ('a@b.c', 'lec', 1, '{"type":"text","text":"慢性骨髓性白血病"}');
INSERT INTO smear_dx (id, canonical_long, canonical_abbrev, topic) VALUES
  ('dx1', '慢性骨髓性白血病', 'CML', 'myeloid');
` +
				cjkMigrationFiles()
					.map((f) => f.sql)
					.join("\n"),
		);

		// 回填那一列。
		assert.deepEqual(ids(db, "questions_fts", ftsQuery("白血病")), ["q1", "q5"]);

		// trigger:遷移之後才寫入的題,以及只出現在選項裡的中文。
		sqlite(
			db,
			`
INSERT INTO questions (id, stem, options_json) VALUES
  ('q2', 'A 65-year-old man with fatigue', '[{"key":"A","text":"慢性骨髓性白血病"},{"key":"B","text":"淋巴瘤"}]'),
  ('q3', 'imatinib for CML', '[]'),
  ('q4', 'lupus erythematosus nephritis', '[]'),
  ('q6', 'CML blast crisis', '[]');
INSERT INTO question_tags (question_id, tag) VALUES ('q6', '骨髓增生');
INSERT INTO lecture_pages (slug, page, text) VALUES
  ('lec', 2, '另一頁也提到慢性骨髓性白血病');
`,
		);

		assert.deepEqual(ids(db, "questions_fts", ftsQuery("白血病")), ["q1", "q2", "q5"]);
		// 只在選項裡。題幹那一列沒有這三個字 —— 清單上的說明是 optionHits 的事。
		assert.ok(ids(db, "questions_fts", ftsQuery("白血病")).includes("q2"));

		assert.deepEqual(ids(db, "questions_fts", ftsQuery("imatinib")), ["q3"]);
		assert.deepEqual(ids(db, "questions_fts", ftsQuery("ima")), ["q3"]);
		assert.deepEqual(ids(db, "questions_fts", ftsQuery('"lupus erythematosus"')), ["q4"]);
		assert.deepEqual(ids(db, "questions_fts", ftsQuery("imatinib, 淋巴瘤")), ["q2", "q3"]);
		assert.deepEqual(ids(db, "questions_fts", ftsQuery("CML NOT imatinib")), ["q6"]);
		assert.deepEqual(ids(db, "questions_fts", ftsQuery("AML OR CML")), ["q3", "q6"]);
		// 標籤裡的中文。
		assert.ok(ids(db, "questions_fts", ftsQuery("骨髓")).includes("q6"));

		// 逗號兩邊的二字不能黏成一個片語。
		assert.deepEqual(ids(db, "questions_fts", '"血病 血小"'), []);
		assert.ok(ids(db, "questions_fts", ftsQuery("血小板")).includes("q5"));

		// 屏障是 U+E000,不是英文字。`c*` 可以命中 CML,不能命中純中文那一列。
		const prefixed = ids(db, "questions_fts", "c*");
		assert.deepEqual(prefixed, ["q3", "q6"]);
		assert.equal(prefixed.includes("q1"), false);

		const lec = sqlite(
			db,
			`SELECT page FROM lecture_pages_fts WHERE lecture_pages_fts MATCH '${ftsPhraseToken("白血病")}' ORDER BY page;`,
		);
		assert.equal(lec.trim(), "1\n2");

		const note = sqlite(
			db,
			`SELECT page FROM lecture_notes_fts WHERE lecture_notes_fts MATCH '${ftsPhraseToken("白血病")}';`,
		);
		assert.equal(note.trim(), "1");

		const smear = sqlite(
			db,
			`SELECT dx_id FROM smear_fts WHERE smear_fts MATCH '${ftsQuery("白血病")}';`,
		);
		assert.equal(smear.trim(), "dx1");

		// 改題幹之後索引要跟著走,否則會一直命中舊詞。
		sqlite(db, `UPDATE questions SET stem = '血小板無力症' WHERE id = 'q1';`);
		assert.equal(ids(db, "questions_fts", ftsQuery("白血病")).includes("q1"), false);
		assert.ok(ids(db, "questions_fts", ftsQuery("血小板")).includes("q1"));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

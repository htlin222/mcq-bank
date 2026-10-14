import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

function questionsDb() {
	const dir = join(ROOT, ".wrangler/state/v3/d1");
	const found = [];
	const walk = (d) => {
		for (const name of readdirSync(d, { withFileTypes: true })) {
			const p = join(d, name.name);
			if (name.isDirectory()) walk(p);
			else if (name.name.endsWith(".sqlite")) found.push(p);
		}
	};
	walk(dir);
	for (const p of found) {
		const db = new DatabaseSync(p, { readOnly: true });
		const hit = db
			.prepare(
				"SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'questions'",
			)
			.get();
		db.close();
		if (hit) return p;
	}
	throw new Error("找不到本機 questions 資料庫");
}

function snapshot(dbPath) {
	const db = new DatabaseSync(dbPath, { readOnly: true });
	const count = db.prepare("SELECT COUNT(*) AS n FROM questions").get().n;
	const row = db
		.prepare(
			"SELECT stem, options_json, answer FROM questions WHERE id = '114-001'",
		)
		.get();
	db.close();
	return { count, row };
}

test("CSV 有一筆截斷選項時整批拒絕，本機題數不變", () => {
	const dbPath = questionsDb();
	const before = snapshot(dbPath);
	const dir = mkdtempSync(join(tmpdir(), "import-cut-"));
	const csv = join(dir, "cut.csv");
	writeFileSync(
		csv,
		[
			"year,number,group,stem,option_a,option_b,option_c,option_d,option_e,answer,tags,difficulty,source",
			"114,1,內科,stem,Lymphomatoid granulomatosis (,whole word,etc.,All of the above,,A,,,",
			"",
		].join("\n"),
	);
	const run = spawnSync(
		process.execPath,
		[
			"--experimental-strip-types",
			"scripts/import-questions.ts",
			csv,
			"--local",
			"--allow-partial-year",
		],
		{ cwd: ROOT, encoding: "utf8" },
	);
	rmSync(dir, { recursive: true, force: true });
	const after = snapshot(dbPath);
	assert.equal(run.status, 2, run.stderr || run.stdout);
	assert.match(run.stderr, /option A ends mid-parenthesis/);
	assert.doesNotMatch(run.stdout, /Inserting/);
	assert.equal(after.count, before.count);
	assert.deepEqual(after.row, before.row);
});

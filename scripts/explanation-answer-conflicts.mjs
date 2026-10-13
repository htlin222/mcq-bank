// 只讀：詳解宣稱的選項 vs questions.answer。
// 衝突與未解析印到 stdout。不 UPDATE、不寫 answer_history。
//
//   node scripts/explanation-answer-conflicts.mjs           # 本機 D1
//   node scripts/explanation-answer-conflicts.mjs --remote  # 正式機，仍只 SELECT

import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { cfg } from "./lib/cfg.mjs";
import { d1Rows } from "./lib/wrangler-json.mjs";
import {
	CONFLICT_SQL,
	assertReadOnlySql,
	classifyExplanation,
	explanationText,
	formatReport,
} from "./lib/explanation-claims.mjs";

export function loadRows(stdout) {
	return d1Rows(stdout, "explanation-answer-conflicts").map((row) =>
		classifyExplanation({
			id: row.id,
			answer: row.answer,
			text: explanationText(row.content_json),
			hasHistory: Number(row.has_history) === 1,
		}),
	);
}

function main() {
	const remote = process.argv.includes("--remote");
	if (process.argv.slice(2).some((a) => a !== "--remote")) {
		console.error("只接受 --remote。不加旗標就是本機。");
		process.exit(2);
	}
	assertReadOnlySql(CONFLICT_SQL);
	const db = cfg("project.d1_db");
	const run = spawnSync(
		"wrangler",
		[
			"d1",
			"execute",
			db,
			remote ? "--remote" : "--local",
			"--json",
			"--command",
			CONFLICT_SQL,
		],
		{ encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
	);
	if (run.status !== 0) {
		console.error(run.stderr || run.stdout || "wrangler d1 execute 失敗");
		process.exit(run.status || 1);
	}
	const items = loadRows(run.stdout);
	process.stdout.write(formatReport(items) + "\n");
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();

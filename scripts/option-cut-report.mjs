// 只讀：既有題庫裡被「字母或括號中段」規則抓到的選項。
// 不 UPDATE questions，也不改 years/ 的來源 JSON。
//
//   node scripts/option-cut-report.mjs           # 本機 D1
//   node scripts/option-cut-report.mjs --remote  # 正式機，仍只 SELECT

import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { cfg } from "./lib/cfg.mjs";
import { d1Rows } from "./lib/wrangler-json.mjs";
import {
	LIST_SQL,
	assertListSql,
	cutsInRow,
	formatReport,
} from "./lib/option-cut-report.mjs";

export function loadHits(stdout) {
	return d1Rows(stdout, "option-cut-report").flatMap((row) => cutsInRow(row));
}

function main() {
	const remote = process.argv.includes("--remote");
	if (process.argv.slice(2).some((a) => a !== "--remote")) {
		console.error("只接受 --remote。不加旗標就是本機。");
		process.exit(2);
	}
	assertListSql();
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
			LIST_SQL,
		],
		{ encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
	);
	if (run.status !== 0) {
		console.error(run.stderr || run.stdout || "wrangler d1 execute 失敗");
		process.exit(run.status || 1);
	}
	process.stdout.write(formatReport(loadHits(run.stdout)) + "\n");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();

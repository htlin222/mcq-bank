#!/usr/bin/env node
/**
 * 重跑一份講義的「歷屆考題」連結(`lecture_page_questions`)。
 *
 *   node --experimental-strip-types scripts/build-slide-mcq-links.ts --slug=lecture-7 [--dry-run] [--remote]
 *
 * --slug 必填。只對那一個 kind='lecture' 的 slug 做 delete-then-insert,
 * 其他 slug 的列不動。不呼叫 Workers AI。
 *
 * 跑完會印 `wrote N`(dry-run 則是 `would write N`)。N 可以是 0:題庫沒有
 * 那個主題時,內容頁就是 0 筆,這是跑完,不是失敗。沒給 slug、slug 不存在、
 * 題庫是空的、或 wrangler 失敗,都是非 0 結束,而且不會印 wrote。
 */

import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { cfg } from "./lib/cfg.mjs";
import { d1Rows } from "./lib/wrangler-json.mjs";
import { linkSlides, linkSql, parseSlideLinkArgs } from "../worker/lib/slide-links.ts";

const D1_DB = cfg("project.d1_db") as string;

async function main() {
	let args: ReturnType<typeof parseSlideLinkArgs>;
	try {
		args = parseSlideLinkArgs(process.argv.slice(2));
	} catch (e) {
		console.error(`❌ ${(e as Error).message}`);
		process.exit(2);
	}
	const mode = args.remote ? "--remote" : "--local";
	const slug = args.slug;
	console.log(
		`🔗 Slide→MCQ links (${mode}${args.dryRun ? ", dry-run" : ""}, slug=${slug})`,
	);
	console.log(`   D1=${D1_DB}  (no Workers AI)`);

	const docs = await d1Json<{ slug: string }>(
		`SELECT slug FROM lecture_docs WHERE kind = 'lecture' AND slug = '${sqlQuote(slug)}' LIMIT 1;`,
		mode,
	);
	if (docs.length === 0) {
		console.error(`❌ 沒有 kind='lecture' 的 slug「${slug}」。沒有寫入。`);
		process.exit(2);
	}

	const qRows = await d1Json<{ id: string; stem: string; tags: string | null }>(
		`SELECT q.id AS id, q.stem AS stem,
        (SELECT GROUP_CONCAT(tag, char(31)) FROM question_tags t WHERE t.question_id = q.id) AS tags
     FROM questions q;`,
		mode,
	);
	if (qRows.length === 0) {
		console.error("❌ 題庫是空的。沒有寫入。");
		process.exit(2);
	}
	const questions = qRows.map((q) => ({
		id: q.id,
		stem: q.stem ?? "",
		tags: q.tags ? q.tags.split("\u001f") : [],
	}));

	const pages = await d1Json<{ page: number; text: string }>(
		`SELECT page, text FROM lecture_pages WHERE slug = '${sqlQuote(slug)}' ORDER BY page;`,
		mode,
	);
	if (pages.length === 0) {
		console.error(`❌ ${slug} 沒有 lecture_pages。沒有寫入。`);
		process.exit(2);
	}

	const report = linkSlides(pages, questions);
	console.log(
		`   ${questions.length} question(s), ${report.pages} page(s): ${report.linkedPages} linked, ${report.emptyPages} with no overlapping term, ${report.shortPages} shorter than 20 chars.`,
	);

	if (args.dryRun) {
		console.log(`result: would write ${report.links.length}`);
		return;
	}

	const sql = linkSql(slug, report.links, Date.now());
	const file = `/tmp/slide-mcq-links-${slug.replace(/[^A-Za-z0-9._-]/g, "_")}.sql`;
	await writeFile(file, sql, "utf8");
	await sh("wrangler", ["d1", "execute", D1_DB, mode, "--file", file]);
	console.log(`result: wrote ${report.links.length}`);
}

function sqlQuote(s: string): string {
	return s.replace(/'/g, "''");
}

async function d1Json<T>(command: string, mode: string): Promise<T[]> {
	const out = await shCapture("wrangler", [
		"d1",
		"execute",
		D1_DB,
		mode,
		"--json",
		"--command",
		command,
	]);
	return d1Rows(out, "slide-mcq-links") as T[];
}

function shCapture(cmd: string, args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "inherit"] });
		let out = "";
		p.stdout.on("data", (d) => {
			out += d.toString();
		});
		p.on("exit", (code) =>
			code === 0 ? resolve(out) : reject(new Error(`${cmd} exited ${code}`)),
		);
	});
}

function sh(cmd: string, args: string[]): Promise<void> {
	return new Promise((resolve, reject) => {
		const p = spawn(cmd, args, { stdio: "inherit" });
		p.on("exit", (code) =>
			code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`)),
		);
	});
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});

#!/usr/bin/env node
/**
 * Alberta 開放教科書的圖 → R2 + smear_questions(source='oer')。
 *
 * Usage:
 *   python3 scripts/smear/fetch_oer.py        # 抓原圖 + 產 data/oer.json
 *   python3 scripts/smear/prepare_oer.py      # 轉 view/full WebP
 *   node --experimental-strip-types scripts/smear/import_oer.ts [--local|--remote]
 *
 * 設計:docs/plans/2026-09-09-smear-station-design.md §2
 *
 * ⚠️ **CC BY-NC 要求標示出處**,attribution 與 source_url 兩欄都必填 ——
 *    這支對缺任何一欄的列直接整批拒,不是跳過那一列。少一個出處在畫面上
 *    看不出來,而那是授權條件不是排版偏好。
 *
 * ⚠️ 跟 import.ts 一樣是 UPSERT,不刪任何列。
 */

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cfg } from "../lib/cfg.mjs";
// ⚠️ 不要自己 `JSON.parse(out.slice(out.indexOf("[")))` —— wrangler 會在 JSON 前面
//    夾人看的文案,而文案裡出現一個方括號就切在錯的地方。理由寫在那支的檔頭。
import { d1Rows } from "../lib/wrangler-json.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const D1_DB = cfg("project.d1_db") as string;
const R2_BUCKET = cfg("project.r2_bucket") as string;

type Row = {
	id: string;
	dx_id: string;
	alt: string;
	source_url: string;
	attribution: string;
	webp_view?: string;
	webp_full?: string;
	needs_review?: boolean;
};

function sh(cmd: string, args: string[]): Promise<void> {
	return new Promise((res, rej) => {
		const p = spawn(cmd, args, { stdio: "inherit" });
		p.on("exit", (c) => (c === 0 ? res() : rej(new Error(`${cmd} exited ${c}`))));
		p.on("error", rej);
	});
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function shRetry(cmd: string, args: string[], n = 3) {
	for (let i = 1; i <= n; i++) {
		try { return await sh(cmd, args); } catch (e) { if (i >= n) throw e; await sleep(400 * i); }
	}
}
// 清單存的是相對於 scripts/smear/ 的路徑(絕對路徑會帶使用者名稱)。
const abs = (p: string) => (p.startsWith("/") ? p : join(HERE, p));
const esc = (s: string) => s.replace(/'/g, "''");
const sqlStr = (s: string | null | undefined) => (s == null ? "NULL" : `'${esc(s)}'`);

async function main() {
	const remote = process.argv.includes("--remote");
	const mode = remote ? "--remote" : "--local";
	const all: Row[] = JSON.parse(await readFile(join(HERE, "data", "oer.json"), "utf-8"));
	// needs_review 的一律跳過。章節頁上的圖不一定都在講這一章的主題(對比圖),
	// 而一張圖掛錯診斷就是直接教錯東西 —— 比少幾張圖糟得多。判準見
	// prepare_oer.py 的 audit()。
	const rows = all.filter((r) => !r.needs_review);
	const held = all.length - rows.length;
	console.log(`📚 OER 匯入 (${mode}) —— ${rows.length} 張` + (held ? `,另 ${held} 張待人工確認` : ""));

	// 全批 pre-flight,一筆錯整批拒(同 import-questions.ts)
	const bad = rows.filter(
		(r) => !r.webp_view || !r.webp_full || !r.attribution || !r.source_url ||
			!existsSync(abs(r.webp_view)) || !existsSync(abs(r.webp_full)),
	);
	if (bad.length) {
		console.error(`✖ ${bad.length} 列缺 WebP 或出處。先跑 prepare_oer.py:`);
		for (const r of bad.slice(0, 8)) console.error(`   ${r.id}`);
		process.exit(1);
	}
	const dxOut = await new Promise<string>((res, rej) => {
		const p = spawn("wrangler",
			["d1", "execute", D1_DB, mode, "--json", "--command", "SELECT id FROM smear_dx"],
			{ stdio: ["ignore", "pipe", "inherit"] });
		let o = ""; p.stdout.on("data", (d) => (o += d));
		p.on("exit", (c) => (c === 0 ? res(o) : rej(new Error(`d1 exited ${c}`))));
	});
	const known = new Set<string>((d1Rows(dxOut) as { id: string }[]).map((r) => r.id));
	const unknown = [...new Set(rows.filter((r) => !known.has(r.dx_id)).map((r) => r.dx_id))];
	if (unknown.length) {
		console.error(`✖ 這些 dx_id 不在 smear_dx 裡,先跑 import.ts:${unknown.join(", ")}`);
		process.exit(1);
	}

	const stmts: string[] = [];
	for (const [i, r] of rows.entries()) {
		const kv = `smear/oer/${r.id}-view.webp`;
		const kf = `smear/oer/${r.id}-full.webp`;
		await shRetry("wrangler", ["r2", "object", "put", `${R2_BUCKET}/${kv}`,
			"--file", abs(r.webp_view!), "--content-type", "image/webp", mode]);
		await shRetry("wrangler", ["r2", "object", "put", `${R2_BUCKET}/${kf}`,
			"--file", abs(r.webp_full!), "--content-type", "image/webp", mode]);
		if ((i + 1) % 20 === 0) console.log(`   ... ${i + 1}/${rows.length}`);
		// ⚠️ image_note 一律 NULL,**不要放 alt**。這本書的 alt 是
		//    `Image 1: Teardrop Cells (Dacrocyte)` —— 逐字就是答案,95 張裡有 37 張
		//    長這樣。而 `image_note` 在 smear.ts 是**無條件**回給前端的
		//    (不在 revealGrade 後面),SmearSession 把它畫在作答框正上方 ——
		//    等於每一題都把正解當圖說印出來。alt 除了答案沒有別的資訊,所以是丟掉
		//    不是遮掉。(2026-09-21 自審抓到)
		stmts.push(
			`INSERT INTO smear_questions (id, dx_id, source, source_ref, source_url, attribution, image_key_view, image_key_full, prompt, image_note, created_at) VALUES ` +
			`('${esc(r.id)}', '${esc(r.dx_id)}', 'oer', 'Alberta OER', ${sqlStr(r.source_url)}, ${sqlStr(r.attribution)}, ` +
			`'${esc(kv)}', '${esc(kf)}', NULL, NULL, ${Date.now()}) ` +
			`ON CONFLICT(id) DO UPDATE SET dx_id = excluded.dx_id, source_url = excluded.source_url, ` +
			`attribution = excluded.attribution, image_key_view = excluded.image_key_view, ` +
			`image_key_full = excluded.image_key_full, image_note = NULL;`,
		);
	}
	const p = "/tmp/smear-oer.sql";
	await writeFile(p, stmts.join("\n"), "utf-8");
	await shRetry("wrangler", ["d1", "execute", D1_DB, mode, "--file", p]);
	console.log(`\n✅ ${rows.length} 張 OER 圖已匯入 smear_questions(source='oer')。`);
}

main().catch((e) => { console.error(e); process.exit(1); });

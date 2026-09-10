#!/usr/bin/env node
/**
 * 跑台案例 → R2 + D1(smear_cases / smear_case_items)。
 *
 * Usage:
 *   node --experimental-strip-types scripts/smear/import_cases.ts [--local|--remote] [--force]
 *
 * 前置:
 *   python3 scripts/smear/parse_cases.py       → data/cases.json + 由人審 data/case-dx.json
 *   python3 scripts/smear/parse_ash_cases.py   → data/cases-ash.json
 *
 * 設計:docs/plans/2026-09-09-smear-station-design.md
 *
 * ⚠️ **`needs_review` 的案一律跳過,不猜。** 和信教學片是講課用的,
 *    `Case 3: ALL vs. FL?` 這種標題的答案是**口頭講的** —— 投影片文字層裡
 *    掃不到任何 final diagnosis / impression / conclusion。猜一個填進去,
 *    使用者練的就是一個錯的正解,而這比少幾個案例糟得多。
 *
 * ⚠️ **和信的頁一定要帶 redaction 才 render。** 投影片上有 `Mr.林 41` 這種
 *    病人識別資訊,而這裡是整頁 render。少了那一步,一個真實病人的姓氏會
 *    出現在網站上,沒有人會注意到。這支腳本自己檢查 cases.json 的
 *    `redactions` 有沒有被套用,沒套用就拒絕跑。
 *
 * ⚠️ 這支跟 import.ts 一樣是**非破壞性的**:UPSERT 內容,不碰
 *    smear_case_attempts。理由見 import.ts 的檔頭。
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { cfg } from "../lib/cfg.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, "data");
const DECK_DIR = join(homedir(), "Dropbox", "血專大補丁", "抹片考訊");
const DECK_FILE: Record<string, string> = {
	"kfs-l1": "20250313_血液_Smear-1.pdf",
	"kfs-l5": "20250702_血液_Smear-5.pdf",
};
const D1_DB = cfg("project.d1_db") as string;
const R2_BUCKET = cfg("project.r2_bucket") as string;
const SCRATCH = "/tmp/smear-cases";

type ParsedPage = {
	page: number;
	image_file?: string;
	modality: string[];
	captions: string[];
	reveal: string[];
};
type ParsedCase = {
	id: string;
	deck: string;
	source_ref: string;
	source_url?: string;
	attribution?: string;
	dx_id?: string;
	title_raw: string;
	history: string[];
	discussion?: string[];
	pages: ParsedPage[];
	redactions: { page: number; text: string }[];
};
type DxRow = { case_id: string; dx_id: string | null; needs_review: boolean };

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
		try {
			return await sh(cmd, args);
		} catch (e) {
			if (i >= n) throw e;
			await sleep(400 * i);
		}
	}
}
const esc = (s: string) => s.replace(/'/g, "''");
const sqlStr = (s: string | null | undefined) => (s == null ? "NULL" : `'${esc(s)}'`);

async function main() {
	const args = process.argv.slice(2);
	const remote = args.includes("--remote");
	const force = args.includes("--force");
	const mode = remote ? "--remote" : "--local";
	console.log(`🔬 Importing smear station cases (${mode})`);

	const kfs: ParsedCase[] = JSON.parse(await readFile(join(DATA, "cases.json"), "utf-8"));
	const ash: ParsedCase[] = JSON.parse(await readFile(join(DATA, "cases-ash.json"), "utf-8"));
	const dxRows: DxRow[] = JSON.parse(await readFile(join(DATA, "case-dx.json"), "utf-8"));
	const dxById = new Map(dxRows.map((r) => [r.case_id, r]));

	// ---------- pre-flight:哪些案可以進,哪些不行 ----------
	const skipped: string[] = [];
	const ready: ParsedCase[] = [];
	for (const c of kfs) {
		const row = dxById.get(c.id);
		if (!row || row.needs_review || !row.dx_id) {
			skipped.push(`${c.id}  ${c.title_raw.slice(0, 46)}`);
			continue;
		}
		ready.push({ ...c, dx_id: row.dx_id });
	}
	for (const c of ash) {
		if (!c.dx_id) {
			skipped.push(`${c.id}  (cases-ash.json 沒有 dx_id)`);
			continue;
		}
		ready.push(c);
	}
	if (skipped.length) {
		console.log(`\n⏭  跳過 ${skipped.length} 案(正解未確認,見 data/case-dx.json):`);
		for (const s of skipped) console.log(`     ${s}`);
		console.log("   確認之後把 dx_id 填上、needs_review 設成 false,再重跑這支。\n");
	}
	if (ready.length === 0) {
		console.error("✖ 一案都沒得匯入。");
		process.exit(1);
	}

	// ---------- 正解必須是真的存在的 dx ----------
	const dxOut = await new Promise<string>((res, rej) => {
		const p = spawn(
			"wrangler",
			["d1", "execute", D1_DB, mode, "--json", "--command", "SELECT id FROM smear_dx"],
			{ stdio: ["ignore", "pipe", "inherit"] },
		);
		let o = "";
		p.stdout.on("data", (d) => (o += d));
		p.on("exit", (c) => (c === 0 ? res(o) : rej(new Error(`d1 exited ${c}`))));
	});
	const known = new Set<string>(
		(JSON.parse(dxOut.slice(dxOut.indexOf("["))) as { results: { id: string }[] }[])[0].results.map(
			(r) => r.id,
		),
	);
	const bad = ready.filter((c) => !known.has(c.dx_id as string));
	if (bad.length) {
		// 全批 pre-flight,一筆錯整批拒 —— 同 import-questions.ts。一個不存在的
		// dx_id 會被 FK 擋下來,但那時已經傳了一半的圖上去了。
		console.error("✖ 這些案的 dx_id 不在 smear_dx 裡,先跑 import.ts 補詞彙:");
		for (const c of bad) console.error(`   ${c.id} → ${c.dx_id}`);
		process.exit(1);
	}

	// ---------- 病史不准含這一案自己的正解 ----------
	//
	// ⚠️ 這道閘是實際踩到才加的。投影片上的圖說寫成 `• 2022/08/03 BM smear:
	//    suspect AML`,而解析器第一版把「開頭有項目符號」的行整行歸進病史 ——
	//    病史是**作答前就顯示的**,於是那 39% 的判讀全部被印在題目上。
	//    畫面上完全看不出來:病史本來就該有日期跟檢驗。
	//
	//    解析器已經修好了,但這道閘留著:下一批素材的排版一定跟這批不一樣,
	//    而「答案出現在題目裡」這種錯不會有人回報得清楚。剝掉並印出來,
	//    不要靜靜放行。
	const termsOut = await new Promise<string>((res, rej) => {
		const p = spawn(
			"wrangler",
			["d1", "execute", D1_DB, mode, "--json", "--command",
			 "SELECT dx_id, text FROM smear_terms WHERE status = 'accepted'"],
			{ stdio: ["ignore", "pipe", "inherit"] },
		);
		let o = "";
		p.stdout.on("data", (d) => (o += d));
		p.on("exit", (c) => (c === 0 ? res(o) : rej(new Error(`d1 exited ${c}`))));
	});
	const termsByDx = new Map<string, string[]>();
	for (const r of (JSON.parse(termsOut.slice(termsOut.indexOf("["))) as
		{ results: { dx_id: string; text: string }[] }[])[0].results) {
		// 三個字元以下的詞不拿來掃 —— 'AA'、'PV' 這種會在任何一段英文裡誤中,
		// 而誤剝掉真的病史比漏掉一次更難察覺。
		if (r.text.trim().length <= 3) continue;
		(termsByDx.get(r.dx_id) ?? termsByDx.set(r.dx_id, []).get(r.dx_id)!).push(r.text.toLowerCase());
	}
	let stripped = 0;
	for (const c of ready) {
		const terms = termsByDx.get(c.dx_id as string) ?? [];
		if (terms.length === 0) continue;
		const kept: string[] = [];
		for (const line of c.history) {
			// ⚠️ 遮掉那個詞,不是刪掉整行。第一版刪整行,結果 ASH 那幾案的臨床
			//    病史被連根拔掉 —— 而「有病史」正是把它們選進 v1 的理由。
			//    洩的是那個詞,不是那句話。
			let out = line;
			for (const t of terms) {
				const re = new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
				if (re.test(out)) {
					console.log(`   ✂ ${c.id} 病史含正解「${t}」,遮掉:${line.slice(0, 66)}`);
					stripped++;
					out = out.replace(re, "▮▮▮");
				}
			}
			// 整行只剩分類路徑之類的殘骸就不要了
			if (out.replace(/[▮\s>·—-]/g, "").length >= 8) kept.push(out);
		}
		c.history = kept;
	}
	if (stripped) console.log(`   共剝掉 ${stripped} 行(答案不該出現在作答前的畫面上)\n`);

	// ---------- render 和信的頁(帶去識別化) ----------
	await mkdir(SCRATCH, { recursive: true });
	const keyOf = (caseId: string, idx: number, label: string) =>
		`smear/case/${caseId}/${String(idx).padStart(2, "0")}-${label}.webp`;

	const uploads: { key: string; file: string; ct: string }[] = [];
	const items: { caseId: string; idx: number; mod: string; view: string; full: string; cap: string | null; rev: string | null }[] = [];

	for (const c of ready.filter((x) => x.deck.startsWith("kfs"))) {
		const deck = DECK_FILE[c.deck];
		const stem = deck.replace(/\.pdf$/, "");
		const redactMap: Record<string, string[]> = {};
		for (const r of c.redactions) (redactMap[String(r.page)] ??= []).push(r.text);
		// ⚠️ 一律傳 --redact-json,即使這一案沒有偵測到 —— 空的清單跟「忘了傳」
		//    在指令列上長得一樣,而後者的代價是病人姓名上線。
		const redactFile = join(SCRATCH, `${c.id}-redact.json`);
		await writeFile(redactFile, JSON.stringify(redactMap), "utf-8");
		const outDir = join(SCRATCH, c.id);
		await sh("python3", [
			join(HERE, "render_pages.py"),
			"--deck", join(DECK_DIR, deck),
			"--out", outDir,
			"--pages", c.pages.map((p) => p.page).join(","),
			"--redact-json", redactFile,
		]);
		c.pages.forEach((p, i) => {
			const view = keyOf(c.id, i, "view");
			const full = keyOf(c.id, i, "full");
			uploads.push({ key: view, file: join(outDir, `${stem}-${String(p.page).padStart(3, "0")}-view.webp`), ct: "image/webp" });
			uploads.push({ key: full, file: join(outDir, `${stem}-${String(p.page).padStart(3, "0")}-full.webp`), ct: "image/webp" });
			items.push({
				caseId: c.id, idx: i, mod: p.modality.join(","),
				view, full,
				cap: p.captions.join(" · ") || null,
				rev: p.reveal.join("\n") || null,
			});
		});
	}

	// ---------- ASH 的圖直接上傳原檔 ----------
	// v1 簡化:view 與 full 指向同一把 key,不做伺服器端二次裁切 —— 同
	// smear-community.ts 的 approve() 已經確立的作法。
	for (const c of ready.filter((x) => x.deck === "ash")) {
		c.pages.forEach((p, i) => {
			if (!p.image_file || !existsSync(p.image_file)) return;
			const key = `smear/case/${c.id}/${String(i).padStart(2, "0")}.jpg`;
			uploads.push({ key, file: p.image_file, ct: "image/jpeg" });
			items.push({ caseId: c.id, idx: i, mod: p.modality.join(","), view: key, full: key, cap: null, rev: null });
		});
	}

	console.log(`\n📤 ${uploads.length} 個物件要上 R2`);
	for (const [i, u] of uploads.entries()) {
		if (!existsSync(u.file)) throw new Error(`render 出來的檔案不見了:${u.file}`);
		await shRetry("wrangler", [
			"r2", "object", "put", `${R2_BUCKET}/${u.key}`,
			"--file", u.file, "--content-type", u.ct, mode,
			...(force ? [] : []),
		]);
		if ((i + 1) % 20 === 0) console.log(`   ... ${i + 1}/${uploads.length}`);
	}

	// ---------- D1 ----------
	const now = Date.now();
	const stmts: string[] = [];
	for (const c of ready) {
		const history = c.history.join("\n") || null;
		const discussion = c.discussion?.length ? JSON.stringify(c.discussion) : null;
		stmts.push(
			`INSERT INTO smear_cases (id, dx_id, history_md, discussion_json, source, source_ref, attribution, created_at) VALUES ` +
				`('${esc(c.id)}', '${esc(c.dx_id as string)}', ${sqlStr(history)}, ${sqlStr(discussion)}, ` +
				`'${esc(c.deck === "ash" ? "ash" : "kfs")}', ${sqlStr(c.source_ref)}, ${sqlStr(c.attribution ?? null)}, ${now}) ` +
				`ON CONFLICT(id) DO UPDATE SET dx_id = excluded.dx_id, history_md = excluded.history_md, ` +
				`discussion_json = excluded.discussion_json, source_ref = excluded.source_ref, ` +
				`attribution = excluded.attribution;`,
		);
		// 步驟整組重建:改動的是內容,而 smear_case_attempts 沒有指向 items 的 FK。
		stmts.push(`DELETE FROM smear_case_items WHERE case_id = '${esc(c.id)}';`);
	}
	for (const it of items) {
		stmts.push(
			`INSERT INTO smear_case_items (case_id, idx, modality, image_key_view, image_key_full, caption, reveal_note) VALUES ` +
				`('${esc(it.caseId)}', ${it.idx}, '${esc(it.mod)}', '${esc(it.view)}', '${esc(it.full)}', ${sqlStr(it.cap)}, ${sqlStr(it.rev)});`,
		);
	}
	const sqlPath = "/tmp/smear-cases.sql";
	await writeFile(sqlPath, stmts.join("\n"), "utf-8");
	await shRetry("wrangler", ["d1", "execute", D1_DB, mode, "--file", sqlPath]);

	console.log(`\n✅ ${ready.length} 案 / ${items.length} 個步驟已匯入。`);
	if (skipped.length) console.log(`   ⏭ ${skipped.length} 案待人工確認正解。`);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});

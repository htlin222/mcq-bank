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
// ⚠️ 不要自己 `JSON.parse(out.slice(out.indexOf("[")))` —— wrangler 會在 JSON 前面
//    夾人看的文案,而文案裡出現一個方括號就切在錯的地方。理由寫在那支的檔頭。
import { d1Rows } from "../lib/wrangler-json.mjs";

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
type DxRow = { case_id: string; dx_id: string | null; needs_review: boolean; excluded?: boolean; why?: string };

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
			// 刻意排除的(excluded)印理由,不是「待確認」—— 兩者混在一起,
			// 看的人會以為那幾案還在等人填。
			skipped.push(`${c.id}  ${row?.excluded ? row.why ?? "排除" : "正解未確認:" + c.title_raw.slice(0, 40)}`);
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
		console.log(`\n⏭  跳過 ${skipped.length} 案(見 data/case-dx.json):`);
		for (const s of skipped) console.log(`     ${s}`);
		console.log("   待確認的:填上 dx_id、needs_review 設成 false,再重跑這支。\n");
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
		(d1Rows(dxOut) as { id: string }[]).map((r) => r.id),
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
	for (const r of d1Rows(termsOut) as { dx_id: string; text: string }[]) {
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
			// 整行只剩分類路徑之類的殘骸就不要了。
			// ⚠️ 只對**真的被遮過**的行套這個長度門檻 —— 對每一行都套的話,
			//    `Plt 12k`(7 字元)這種正常的檢驗數據會被靜默丟掉。
			if (line === out || out.replace(/[▮\s>·—-]/g, "").length >= 8) kept.push(out);
		}
		c.history = kept;
	}
	if (stripped) console.log(`   共剝掉 ${stripped} 行(答案不該出現在作答前的畫面上)\n`);

	// ---------- render 和信的頁(去識別化 + 遮掉文字層) ----------
	await mkdir(SCRATCH, { recursive: true });

	type Step = {
		caseId: string; dxId: string; mod: string;
		viewFile: string; fullFile: string; ct: string; ext: string;
		cap: string | null; rev: string | null;
	};
	const stepsByCase = new Map<string, Step[]>();

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
		const reportFile = join(SCRATCH, `${c.id}-redact-report.json`);
		await sh("python3", [
			join(HERE, "render_pages.py"),
			"--deck", join(DECK_DIR, deck),
			"--out", outDir,
			"--pages", c.pages.map((p) => p.page).join(","),
			"--redact-json", redactFile,
			"--redact-report", reportFile,
			// ⚠️ 一律帶。投影片每一張都印著標題,而標題就是答案;實測不帶的話
			//    39 張步驟圖 39 張 OCR 掃得到洩題。臨床文字另外以純文字送。
			"--strip-text",
		]);
		// ⚠️ 檔頭承諾了「沒套用就拒絕跑」,而第一版只是把參數傳過去,沒有人檢查結果。
		//    `page.search_for()` 找不到就是靜靜回空 list —— PyMuPDF 把 `Mr.林` 拆在
		//    兩個 span、或空白正規化不同,姓名就原樣進圖而沒有任何一層會吵
		//    (OCR 稽核明講不涵蓋姓名)。整批拒絕,不要跳過那一頁:一個沒遮到的
		//    姓名比少一案嚴重得多。(2026-09-21 自審抓到)
		const report = JSON.parse(await readFile(reportFile, "utf-8")) as Record<string, number>;
		const missed = Object.entries(report).filter(([, n]) => n === 0).map(([k]) => k);
		if (missed.length) {
			console.error(
				`✖ ${c.id}:這些要遮的字串在 PDF 裡一次都沒命中,姓名會原樣進圖:\n` +
					missed.map((m) => `   ${JSON.stringify(m)}`).join("\n"),
			);
			process.exit(1);
		}

		const pageFile = (page: number, label: string) =>
			join(outDir, `${stem}-${String(page).padStart(3, "0")}-${label}.webp`);
		stepsByCase.set(c.id, c.pages.map((p) => ({
			caseId: c.id, dxId: c.dx_id as string, mod: p.modality.join(","),
			viewFile: pageFile(p.page, "view"), fullFile: pageFile(p.page, "full"),
			ct: "image/webp", ext: "webp",
			cap: p.captions.join(" · ") || null,
			rev: p.reveal.join("\n") || null,
		})));
	}

	// ---------- ASH 的圖直接上傳原檔 ----------
	// v1 簡化:view 與 full 指向同一個檔,不做伺服器端二次裁切 —— 同
	// smear-community.ts 的 approve() 已經確立的作法。
	for (const c of ready.filter((x) => x.deck === "ash")) {
		stepsByCase.set(c.id, c.pages
			.filter((p) => p.image_file && existsSync(p.image_file))
			.map((p) => ({
				caseId: c.id, dxId: c.dx_id as string, mod: p.modality.join(","),
				viewFile: p.image_file!, fullFile: p.image_file!, ct: "image/jpeg", ext: "jpg",
				cap: null, rev: null,
			})));
	}

	// ---------- OCR 稽核:圖上看得到答案的步驟剔除 ----------
	//
	// --strip-text 只遮得掉文字層。病理報告截圖、烙在圖裡的標籤是點陣圖,
	// 文字層裡不存在 —— 實測遮完文字層之後 72 張裡還有 5 張看得到正解。
	// 判準與限制見 audit_case_images.py 的檔頭。
	const manifest = [...stepsByCase.values()].flat().map((s, i) => ({
		case_id: s.caseId, idx: i, file: s.fullFile, dx_id: s.dxId,
	}));
	const manifestPath = join(SCRATCH, "ocr-manifest.json");
	await writeFile(manifestPath, JSON.stringify(manifest), "utf-8");
	await sh("python3", [join(HERE, "audit_case_images.py"), manifestPath]);
	const leaked = new Set(
		(JSON.parse(await readFile(manifestPath, "utf-8")) as { idx: number; leak: string[] }[])
			.filter((r) => r.leak.length > 0).map((r) => r.idx),
	);

	const uploads: { key: string; file: string; ct: string }[] = [];
	const items: { caseId: string; idx: number; mod: string; view: string; full: string; cap: string | null; rev: string | null }[] = [];
	// 被剔除那一步的原文不丟:併進揭曉後的整案討論。那一頁多半是病理報告,
	// 正是揭曉時最該看到的東西 —— 只是不能在作答前看到。
	const droppedNotes = new Map<string, string[]>();
	let flatIdx = 0;
	for (const [caseId, steps] of stepsByCase) {
		let idx = 0;
		for (const s of steps) {
			if (leaked.has(flatIdx++)) {
				if (s.rev) (droppedNotes.get(caseId) ?? droppedNotes.set(caseId, []).get(caseId)!).push(s.rev);
				continue;
			}
			const base = `smear/case/${caseId}/${String(idx).padStart(2, "0")}`;
			const view = s.viewFile === s.fullFile ? `${base}.${s.ext}` : `${base}-view.${s.ext}`;
			const full = s.viewFile === s.fullFile ? view : `${base}-full.${s.ext}`;
			uploads.push({ key: view, file: s.viewFile, ct: s.ct });
			if (full !== view) uploads.push({ key: full, file: s.fullFile, ct: s.ct });
			items.push({ caseId, idx, mod: s.mod, view, full, cap: s.cap, rev: s.rev });
			idx++;
		}
	}
	for (const c of ready) {
		const extra = droppedNotes.get(c.id);
		if (extra?.length) c.discussion = [...(c.discussion ?? []), ...extra];
		if (!items.some((it) => it.caseId === c.id)) {
			// 全部步驟都被剔除的案不該上線 —— 一張圖都沒有的跑台不是跑台。
			throw new Error(`${c.id} 的步驟圖全部在 OCR 稽核中被剔除,檢查這一案的素材`);
		}
	}

	console.log(`\n📤 ${uploads.length} 個物件要上 R2`);
	for (const [i, u] of uploads.entries()) {
		if (!existsSync(u.file)) throw new Error(`render 出來的檔案不見了:${u.file}`);
		await shRetry("wrangler", [
			"r2", "object", "put", `${R2_BUCKET}/${u.key}`,
			"--file", u.file, "--content-type", u.ct, mode,
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
	if (skipped.length) console.log(`   ⏭ 跳過 ${skipped.length} 案(見上方理由)。`);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});

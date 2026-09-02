#!/usr/bin/env node
/**
 * Combine all years/<n>/batches/*.json into a single CSV that
 * `import-questions.ts` can ingest.
 *
 * Usage:  node scripts/batches-to-csv.ts > all-questions.csv
 *         node scripts/batches-to-csv.ts --year 103 > y103.csv
 *
 * ⚠️ **加新年份時一定要用 `--year`。** `import-questions.ts` 的寫入是 upsert,
 * 而它會**無條件覆蓋 `answer`** —— 把整份 CSV 倒進去,等於把社群透過答案挑戰
 * 流程升級過的正解**靜靜蓋回**原始匯入值,而且不留痕跡。只匯入新的那一年,
 * 這個風險就不存在。
 *
 * Normalizations (so the strict importer accepts agent output):
 *   - empty `answer`        → 'A' + tag '答案待確認' (must be human-verified)
 *   - stem length < 20      → tag '待補題幹'
 *   - confidence < 0.7      → tag '低信心需覆核'
 *   - 3-option questions    → already padded by agents with placeholder D
 *
 * The CSV header matches scripts/import-questions.ts exactly.
 */
import { readFile, writeFile } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

type Q = {
	number: number;
	// Group label — must match one of the labels in config.toml [groups].list.
	group: string;
	stem: string;
	options: Record<string, string>;
	answer: string;
	tags: string[];
	explanation_md: string;
	confidence: number;
	oe_consulted: boolean;
};

const ROOT = "/Users/htlin/hema-2026";

/**
 * 有 batches/ 的年份就算 —— **不要用硬編碼的清單**。
 *
 * 這裡原本寫死成 [104..113]，而 114 年早就存在 —— 也就是說這支腳本從來沒有
 * 把 114 吐進 CSV，而且**不會報錯**，只是那一年靜靜消失。同樣的清單在
 * `seed-explanations.py` 也各寫了一份、也漏掉 114。三份清單要同步的東西，
 * 遲早會有一份沒跟上，而症狀是「某一年不見了」——沒有任何地方會抱怨。
 *
 * 改成掃目錄之後，加一個新年份只要建 `years/<年>/batches/`，一行程式都不用改。
 */
async function discoverYears(): Promise<number[]> {
	const entries = await readdir(join(ROOT, "years"), { withFileTypes: true });
	const years: number[] = [];
	for (const e of entries) {
		if (!e.isDirectory()) continue;
		const n = Number(e.name);
		if (!Number.isInteger(n)) continue;
		try {
			await readdir(join(ROOT, "years", e.name, "batches"));
			years.push(n);
		} catch {
			/* 沒有 batches/ 的年份目錄 —— 略過 */
		}
	}
	return years.sort((a, b) => a - b);
}

function csvEscape(s: string): string {
	if (s == null) return "";
	const needsQuote = /[,"\n\r]/.test(s);
	const escaped = s.replace(/"/g, '""');
	return needsQuote ? `"${escaped}"` : escaped;
}

async function main() {
	const header = [
		"year",
		"number",
		"group",
		"stem",
		"option_a",
		"option_b",
		"option_c",
		"option_d",
		"option_e",
		"answer",
		"tags",
		"difficulty",
		"source",
	];
	const rows: string[] = [header.join(",")];

	let total = 0;
	let fixedAnswers = 0;
	let stubStems = 0;
	let lowConf = 0;

	// `--year <n>` 只輸出那一年(見檔頭的 upsert 警告)。
	const yearArg = process.argv.indexOf("--year");
	const only = yearArg >= 0 ? Number(process.argv[yearArg + 1]) : null;
	if (yearArg >= 0 && !Number.isInteger(only)) {
		console.error("--year 需要一個整數年份,例如 --year 103");
		process.exit(1);
	}
	const YEARS = (await discoverYears()).filter(
		(y) => only === null || y === only,
	);
	if (YEARS.length === 0) {
		console.error(`找不到 years/${only}/batches/ —— 沒有東西可以輸出`);
		process.exit(1);
	}
	for (const year of YEARS) {
		const batchDir = join(ROOT, "years", String(year), "batches");
		let files: string[] = [];
		try {
			files = (await readdir(batchDir))
				.filter((f) => f.startsWith("batch-") && f.endsWith(".json"))
				.sort();
		} catch {
			process.stderr.write(`! year ${year}: no batches/ dir, skipping\n`);
			continue;
		}
		const yearQs: Q[] = [];
		for (const f of files) {
			const raw = await readFile(join(batchDir, f), "utf-8");
			const batch: Q[] = JSON.parse(raw);
			yearQs.push(...batch);
		}
		yearQs.sort((a, b) => a.number - b.number);

		for (const q of yearQs) {
			const tags = new Set(q.tags || []);

			let answer = (q.answer || "").trim().toUpperCase();
			if (!answer) {
				answer = "A";
				tags.add("答案待確認");
				fixedAnswers++;
			}
			if ((q.stem || "").trim().length < 20) {
				tags.add("待補題幹");
				stubStems++;
			}
			if ((q.confidence ?? 1.0) < 0.7) {
				tags.add("低信心需覆核");
				lowConf++;
			}

			// Pad empty options with placeholder so the importer's
			// "answer must have matching option text" check passes.
			// Tagged for human review.
			const opts = q.options || {};
			const padIfEmpty = (k: string) => (opts[k] && opts[k].trim()) || "";
			const a = padIfEmpty("A");
			const b = padIfEmpty("B");
			const c = padIfEmpty("C");
			const d = padIfEmpty("D");
			const e = padIfEmpty("E");
			const padded = { A: a, B: b, C: c, D: d, E: e };
			let didPad = false;
			if (!padded[answer as "A" | "B" | "C" | "D" | "E"]) {
				padded[answer as "A" | "B" | "C" | "D" | "E"] = "(待補)";
				didPad = true;
			}
			// Pad ALL empty A-D so the UI shows obvious placeholders for stub Qs.
			// E stays empty if originally empty (it's optional).
			for (const k of ["A", "B", "C", "D"] as const) {
				if (!padded[k]) {
					padded[k] = "(待補)";
					didPad = true;
				}
			}
			if (didPad) tags.add("待補選項");

			const row = [
				String(year),
				String(q.number),
				q.group,
				q.stem || "(待補題幹)",
				padded.A,
				padded.B,
				padded.C,
				padded.D,
				padded.E,
				answer,
				[...tags].join(";"),
				"", // difficulty
				`years/${year}/batches`,
			]
				.map(csvEscape)
				.join(",");
			rows.push(row);
			total++;
		}
		process.stderr.write(`  year ${year}: ${yearQs.length} Qs\n`);
	}

	const csv = rows.join("\n") + "\n";
	process.stdout.write(csv);
	process.stderr.write(
		`\n✓ Wrote ${total} questions to stdout (CSV)\n` +
			`  - ${fixedAnswers} empty answers normalized → 'A' + tag '答案待確認'\n` +
			`  - ${stubStems} short stems tagged '待補題幹'\n` +
			`  - ${lowConf} low-confidence tagged '低信心需覆核'\n`,
	);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});

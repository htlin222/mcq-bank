#!/usr/bin/env node
/**
 * Backfill question vectors into Cloudflare Vectorize.
 *
 * Usage:
 *   node --experimental-strip-types scripts/backfill-vectors.ts [--remote] [--local] [--dry-run]
 *
 *   --remote    read questions from prod D1 (default if neither flag passed)
 *   --local     read questions from local .wrangler/state (dev sanity only)
 *   --dry-run   embed the first 3 questions, print dims, upsert NOTHING
 *
 * What it does (idempotent — upsert overwrites by id):
 *   1. SELECT id, year, "group", stem, options_json + aggregated tags from D1.
 *   2. For each question, build "stem\n<options>\n<tags>" and embed it with
 *      @cf/baai/bge-base-en-v1.5 (768-dim) via the Workers AI REST API,
 *      batching several texts per call.
 *   3. Upsert {id, values, metadata:{year,group,tags}} into the Vectorize
 *      index (project.vectorize_index) via the Vectorize v2 REST API.
 *
 * Powers: #2 semantic 相似題 (worker/routes/questions.ts) and #6 weakness
 * clustering. The Worker reads the same index via the VEC binding.
 *
 * Env (from the shell, same as the other deploy scripts):
 *   CLOUDFLARE_ACCOUNT_ID / CF_ACCOUNT_ID   — account id
 *   CLOUDFLARE_API_TOKEN  / CF_API_TOKEN    — token needs Workers AI Read
 *                                             AND Vectorize Edit
 *
 * NOTE: this is a one-time remote write. Run --dry-run first.
 */

import { spawn } from "node:child_process";
import { cfg } from "./lib/cfg.mjs";
import { d1Rows } from "./lib/wrangler-json.mjs";

const D1_DB = cfg("project.d1_db") as string;
const VEC_INDEX = cfg("project.vectorize_index") as string;
const EMBED_MODEL = "@cf/baai/bge-base-en-v1.5";
const EMBED_DIMS = 768;
const EMBED_BATCH = 50; // texts per AI call
const UPSERT_BATCH = 100; // vectors per Vectorize upsert call

const ACCOUNT_ID =
	process.env.CLOUDFLARE_ACCOUNT_ID || process.env.CF_ACCOUNT_ID || "";
const API_TOKEN =
	process.env.CLOUDFLARE_API_TOKEN || process.env.CF_API_TOKEN || "";

interface QRow {
	id: string;
	year: number;
	group: string | null;
	stem: string;
	options_json: string;
	tags: string | null; // GROUP_CONCAT, comma-separated
}

interface VectorRecord {
	id: string;
	values: number[];
	metadata: { year: number; group: string; tags: string };
}

async function main() {
	const args = process.argv.slice(2);
	const dryRun = args.includes("--dry-run");
	const remote = args.includes("--remote") || !args.includes("--local");
	const mode = remote ? "--remote" : "--local";

	console.log(
		`🧮 Backfill vectors → Vectorize (${mode}${dryRun ? ", DRY-RUN" : ""})`,
	);
	console.log(`   D1=${D1_DB}  index=${VEC_INDEX}  model=${EMBED_MODEL}`);

	// Even --dry-run embeds (to verify dims), so creds are always required.
	if (!ACCOUNT_ID || !API_TOKEN) {
		console.error(
			"❌ CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN must be exported in this shell.\n" +
				"   The token needs Workers AI (Read) for embedding" +
				(dryRun ? "." : " AND Vectorize (Edit) for upsert."),
		);
		process.exit(2);
	}

	// ── Load questions from D1 ──
	const listJson = await shCapture("wrangler", [
		"d1",
		"execute",
		D1_DB,
		mode,
		"--json",
		"--command",
		`SELECT q.id, q.year, q."group" AS "group", q.stem, q.options_json,
            (SELECT GROUP_CONCAT(tag, ',') FROM question_tags t WHERE t.question_id = q.id) AS tags
     FROM questions q ORDER BY q.year DESC, q.number ASC;`,
	]);
	const rows: QRow[] = d1Rows(
		listJson,
		"backfill-vectors 讀 questions",
	) as QRow[];
	if (rows.length === 0) {
		console.error("❌ No questions found in D1.");
		process.exit(2);
	}
	console.log(`   Loaded ${rows.length} question(s).\n`);

	const targets = dryRun ? rows.slice(0, 3) : rows;

	// ── Embed in batches ──
	const records: VectorRecord[] = [];
	for (let i = 0; i < targets.length; i += EMBED_BATCH) {
		const batch = targets.slice(i, i + EMBED_BATCH);
		const texts = batch.map(embedText);
		const vectors = await embed(texts);
		for (let j = 0; j < batch.length; j++) {
			const q = batch[j];
			const values = vectors[j];
			if (!Array.isArray(values) || values.length !== EMBED_DIMS) {
				throw new Error(
					`bad embedding for ${q.id}: got ${values?.length} dims, expected ${EMBED_DIMS}`,
				);
			}
			records.push({
				id: q.id,
				values,
				metadata: { year: q.year, group: q.group ?? "", tags: q.tags ?? "" },
			});
		}
		console.log(
			`   embedded ${Math.min(i + EMBED_BATCH, targets.length)}/${targets.length}`,
		);
	}

	if (dryRun) {
		console.log("\n🔎 DRY-RUN sample:");
		for (const r of records) {
			console.log(
				`   ${r.id}  dims=${r.values.length}  meta=${JSON.stringify(r.metadata)}`,
			);
		}
		console.log(
			"\n   OK — dims look right; re-run without --dry-run to upsert.",
		);
		return;
	}

	// ── Upsert to Vectorize in batches ──
	let done = 0;
	for (let i = 0; i < records.length; i += UPSERT_BATCH) {
		const batch = records.slice(i, i + UPSERT_BATCH);
		await upsert(batch);
		done += batch.length;
		console.log(`   upserted ${done}/${records.length}`);
	}
	console.log(`\n✅ Backfilled ${records.length} vectors into ${VEC_INDEX}.`);
}

/** stem + options text + tags — the text we index per question. */
function embedText(q: QRow): string {
	let opts = "";
	try {
		const parsed = JSON.parse(q.options_json) as {
			key: string;
			text: string;
		}[];
		opts = parsed.map((o) => `${o.key}. ${o.text}`).join("\n");
	} catch {
		opts = "";
	}
	return [q.stem, opts, q.tags ?? ""].filter(Boolean).join("\n");
}

/** Workers AI REST: returns one 768-dim vector per input text. */
async function embed(texts: string[]): Promise<number[][]> {
	const url = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/ai/run/${EMBED_MODEL}`;
	const res = await fetch(url, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${API_TOKEN}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ text: texts }),
	});
	if (!res.ok)
		throw new Error(`AI embed failed ${res.status}: ${await res.text()}`);
	const json = (await res.json()) as {
		success: boolean;
		result?: { data?: number[][] };
		errors?: unknown;
	};
	const data = json?.result?.data;
	if (!json.success || !Array.isArray(data)) {
		throw new Error(`AI embed error: ${JSON.stringify(json.errors ?? json)}`);
	}
	return data;
}

/** Vectorize v2 REST upsert — body is newline-delimited JSON (ndjson). */
async function upsert(records: VectorRecord[]): Promise<void> {
	const url = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/vectorize/v2/indexes/${VEC_INDEX}/upsert`;
	const ndjson = records.map((r) => JSON.stringify(r)).join("\n");
	const res = await fetch(url, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${API_TOKEN}`,
			"Content-Type": "application/x-ndjson",
		},
		body: ndjson,
	});
	if (!res.ok)
		throw new Error(
			`Vectorize upsert failed ${res.status}: ${await res.text()}`,
		);
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

main().catch((e) => {
	console.error(e);
	process.exit(1);
});

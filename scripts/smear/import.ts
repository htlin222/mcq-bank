#!/usr/bin/env node
/**
 * Import 抹片練習 (smear practice) content into R2 + D1.
 *
 * Usage:
 *   node --experimental-strip-types scripts/smear/import.ts [--local|--remote] [--force]
 *
 *   --local   target .wrangler/state emulation (default)
 *   --remote  target prod R2 + D1
 *   --force   re-upload to R2 even if the object already exists (default:
 *             skip — mirrors scripts/import-lectures.ts's --force)
 *
 * What this does, in FK-dependency order:
 *   1. Render all pages of the 4 exam decks (scripts/smear/render_pages.py,
 *      no --limit) into a scratch dir.
 *   2. Join each of the 203 raw answer rows (raw-answers.json) to its dx_id
 *      via dx.json's source_answers[] — every row MUST resolve, or this is
 *      a hard error (already verified 203/203 during the A3 audit; this is
 *      a re-check, not a first check).
 *   3. Upload exam page images + ASH supplementary images to R2.
 *   4. Delete-then-insert every smear_* table (idempotent re-run).
 *
 * See docs/plans/2026-09-03-smear-practice-design.md and
 * migrations/0043_smear.sql for the schema this fills in.
 *
 * ⚠️ Re-running this script wipes smear_sessions / smear_answers /
 *    smear_term_votes ENTIRELY (not just import-derived rows) — see the
 *    "delete-then-insert" section below. That's fine pre-launch (no real
 *    user data exists yet); don't run this against a live remote DB without
 *    accounting for that.
 */

import { readFile, mkdir, writeFile, stat, readdir } from "node:fs/promises";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { cfg } from "../lib/cfg.mjs";
// Cross-import from worker/lib, same pattern as scripts/build-slide-mcq-links.ts
// importing worker/lib/ai-models.ts. MUST be the real function — a second
// reimplementation of normalizeTerm would let the two diverge (called out
// explicitly in worker/lib/smear-grade.ts's own header comment).
import { normalizeTerm } from "../../worker/lib/smear-grade.ts";

const execFileP = promisify(execFile);

const HERE = dirname(fileURLToPath(import.meta.url));
const SMEAR_DIR = HERE; // scripts/smear
const DATA_DIR = join(SMEAR_DIR, "data");
const SCRATCH_DIR = "/tmp/smear-import/pages";

// Source PDFs live outside the repo (per docs/plans/2026-09-03-smear-practice-design.md).
const DECK_SOURCE_DIR = join(homedir(), "Dropbox", "血專大補丁", "抹片考訊");
const ASH_DATA_DIR = join(homedir(), "ash-image-bank", "data");
const ASH_INDEX_PATH = join(ASH_DATA_DIR, "index.jsonl");

const D1_DB = cfg("project.d1_db") as string;
const R2_BUCKET = cfg("project.r2_bucket") as string;

// Short, readable per-deck codes for smear_questions.id — matches Test-1..4
// in the answer-key filenames.
const SHORT_CODE: Record<string, string> = {
	"Test-1-ANS.pdf": "t1",
	"Test-2-ANS.pdf": "t2",
	"Test-3-ANS.pdf": "t3",
	"Test-4-ANS.pdf": "t4",
};

// ------------------------------------------------------------
// Types (shapes of the JSON produced by earlier Phase A tasks)
// ------------------------------------------------------------
type RawAnswer = {
	key: string;
	n: number;
	raw: string;
	main: string;
	alts: string[];
	half: string[];
};
type Tier = "full" | "half" | "lay";
type Form = "long" | "abbrev";
type Term = { text: string; tier: Tier; form: Form };
type SourceAnswerRef = { key: string; n: number };
type Dx = {
	dx_id: string;
	canonical_long: string;
	canonical_abbrev: string | null;
	topic: string;
	qtype: "cell" | "disease";
	terms: Term[];
	source_answers: SourceAnswerRef[];
};
type DxNote = {
	dx_id: string;
	content_json: unknown;
	related_dx_ids?: string[] | null;
};
type AshMap = Record<string, string[]>;
type AshIndexEntry = {
	id: string;
	collection: string;
	url: string;
	title: string;
	author: string;
	image_file: string;
};

async function main() {
	const args = process.argv.slice(2);
	const remote = args.includes("--remote");
	const force = args.includes("--force");
	const mode = remote ? "--remote" : "--local";

	console.log(`🩸 Importing smear practice content (${mode})`);
	console.log(`   D1=${D1_DB}  R2=${R2_BUCKET}`);

	// ---------- Load Phase A JSON outputs ----------
	const rawAnswers: RawAnswer[] = JSON.parse(
		await readFile(join(DATA_DIR, "raw-answers.json"), "utf-8"),
	);
	const dxList: Dx[] = JSON.parse(
		await readFile(join(DATA_DIR, "dx.json"), "utf-8"),
	);
	const ashMap: AshMap = JSON.parse(
		await readFile(join(DATA_DIR, "ash-map.json"), "utf-8"),
	);
	const dxNotes: DxNote[] = JSON.parse(
		await readFile(join(DATA_DIR, "dx-notes.json"), "utf-8"),
	);

	console.log(
		`   loaded: ${rawAnswers.length} raw answers, ${dxList.length} dx, ` +
			`${Object.keys(ashMap).length} dx→ASH mappings, ${dxNotes.length} dx notes`,
	);

	// ---------- DECK_MAP: read straight from parse_answers.py, don't duplicate ----------
	const deckMap = await loadDeckMap();
	const deckFiles = [...new Set(Object.values(deckMap))];
	console.log(`   DECK_MAP: ${JSON.stringify(deckMap)}`);

	// ---------- Pre-flight 1: every raw answer resolves to exactly one dx_id ----------
	const bySourceKey = new Map<string, string>(); // "key::n" -> dx_id
	for (const dx of dxList) {
		for (const sa of dx.source_answers) {
			const k = `${sa.key}::${sa.n}`;
			if (bySourceKey.has(k)) {
				throw new Error(
					`join error: source answer ${k} claimed by both dx="${bySourceKey.get(k)}" and dx="${dx.dx_id}"`,
				);
			}
			bySourceKey.set(k, dx.dx_id);
		}
	}
	const unresolved: RawAnswer[] = [];
	const rawToDx = new Map<string, string>(); // "key::n" -> dx_id, keyed by the 203 raw rows only
	for (const ra of rawAnswers) {
		const k = `${ra.key}::${ra.n}`;
		const dxId = bySourceKey.get(k);
		if (!dxId) {
			unresolved.push(ra);
		} else {
			rawToDx.set(k, dxId);
		}
	}
	if (unresolved.length > 0) {
		console.error(
			`\n❌ ${unresolved.length} raw answer row(s) do not resolve to any dx_id:`,
		);
		for (const u of unresolved) console.error(`   ${u.key} #${u.n}: ${u.raw}`);
		process.exit(2);
	}
	console.log(
		`✓ Pre-flight: all ${rawAnswers.length} raw answers resolve to a dx_id.`,
	);

	// ---------- Pre-flight 2: deck source PDFs exist ----------
	const deckPaths: Record<string, string> = {};
	for (const f of deckFiles) {
		const p = join(DECK_SOURCE_DIR, f);
		try {
			await stat(p);
		} catch {
			console.error(`❌ deck PDF not found: ${p}`);
			process.exit(2);
		}
		deckPaths[f] = p;
	}

	// ---------- Pre-flight 3: every ASH mapping resolves to a real file on disk ----------
	const ashIndex = await loadAshIndex();
	const ashMissing: { dxId: string; ashId: string; reason: string }[] = [];
	const ashResolved = new Map<string, { entry: AshIndexEntry; path: string }>();
	for (const [dxId, ids] of Object.entries(ashMap)) {
		for (const ashId of ids) {
			const entry = ashIndex.get(ashId);
			if (!entry) {
				ashMissing.push({ dxId, ashId, reason: "not in index.jsonl" });
				continue;
			}
			const path = join(
				ASH_DATA_DIR,
				entry.collection,
				ashId,
				entry.image_file,
			);
			try {
				await stat(path);
				ashResolved.set(ashId, { entry, path });
			} catch {
				ashMissing.push({ dxId, ashId, reason: `file not found: ${path}` });
			}
		}
	}
	if (ashMissing.length > 0) {
		console.error(
			`\n❌ ${ashMissing.length} ASH image mapping(s) do not resolve to a real file:`,
		);
		for (const m of ashMissing)
			console.error(`   dx=${m.dxId} ash=${m.ashId}: ${m.reason}`);
		console.error(
			"   Fix ash-map.json or the local ash-image-bank checkout, then re-run.",
		);
		process.exit(2);
	}
	console.log(
		`✓ Pre-flight: all ${[...Object.values(ashMap)].flat().length} ASH mappings resolve to real files.`,
	);

	// Built early so both the render-skip check below and the post-render
	// verification step (further down) share one source of truth — never
	// duplicate this counting logic.
	const rawCountByKey = new Map<string, number>();
	for (const ra of rawAnswers)
		rawCountByKey.set(ra.key, (rawCountByKey.get(ra.key) ?? 0) + 1);

	// ---------- Step 1: render all pages of all 4 decks ----------
	await mkdir(SCRATCH_DIR, { recursive: true });
	console.log(
		`\n🖼  Rendering ${deckFiles.length} decks to ${SCRATCH_DIR} (no --limit; full decks)…`,
	);
	for (const f of deckFiles) {
		const stem = basename(f, ".pdf");
		// deckMap is raw-answer-key -> deckFile, 1:1 for these 4 decks (see
		// parse_answers.py's DECK_MAP) — reverse-lookup the key to know how
		// many pages this deck is expected to have already rendered.
		const key = Object.entries(deckMap).find(([, df]) => df === f)?.[0];
		const expected = key ? (rawCountByKey.get(key) ?? 0) : 0;
		const existing = (await readdir(SCRATCH_DIR)).filter(
			(p) => p.startsWith(`${stem}-`) && p.endsWith("-view.webp"),
		).length;
		if (expected > 0 && existing === expected) {
			console.log(`⏭ skip render ${f} (already have ${existing} pages)`);
			continue;
		}
		const t0 = Date.now();
		await sh("python3", [
			join(SMEAR_DIR, "render_pages.py"),
			"--deck",
			deckPaths[f],
			"--out",
			SCRATCH_DIR,
		]);
		console.log(`   rendered ${f} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
	}

	// ---------- Verify: rendered page count matches raw-answers count per deck ----------
	for (const [key, deckFile] of Object.entries(deckMap)) {
		const stem = basename(deckFile, ".pdf");
		const expected = rawCountByKey.get(key) ?? 0;
		const files = await readdir(SCRATCH_DIR);
		const viewCount = files.filter(
			(f) => f.startsWith(`${stem}-`) && f.endsWith("-view.webp"),
		).length;
		if (viewCount !== expected) {
			console.error(
				`❌ ${deckFile}: rendered ${viewCount} view pages but raw-answers.json expects ${expected} (key=${key})`,
			);
			process.exit(2);
		}
		console.log(
			`✓ ${deckFile}: ${viewCount} rendered pages == ${expected} raw answers.`,
		);
	}

	// ---------- Step: qtype/topic lookup for prompt derivation ----------
	const dxById = new Map(dxList.map((d) => [d.dx_id, d]));
	function promptFor(dxId: string): string {
		const dx = dxById.get(dxId);
		// Original PDF prompt text was never reliably extracted as structured
		// data in earlier Phase A tasks — derive a reasonable default from qtype.
		return dx?.qtype === "cell" ? "What cell?" : "What disease?";
	}

	// ---------- Step: build smear_questions rows (exam source) + upload images ----------
	type QuestionRow = {
		id: string;
		dx_id: string;
		source: "exam" | "ash";
		source_ref: string | null;
		source_url: string | null;
		attribution: string | null;
		image_key_view: string;
		image_key_full: string;
		prompt: string | null;
		image_note: string | null;
	};
	const questionRows: QuestionRow[] = [];

	type UploadTask = { key: string; path: string; contentType: string };
	const examUploads: UploadTask[] = [];
	for (const ra of rawAnswers) {
		const deckFile = deckMap[ra.key];
		const stem = basename(deckFile, ".pdf");
		const page = ra.n;
		const pageStr = String(page).padStart(3, "0");
		const viewFile = `${stem}-${pageStr}-view.webp`;
		const fullFile = `${stem}-${pageStr}-full.webp`;
		const viewKey = `smear/exam/${viewFile}`;
		const fullKey = `smear/exam/${fullFile}`;

		examUploads.push({
			key: viewKey,
			path: join(SCRATCH_DIR, viewFile),
			contentType: "image/webp",
		});
		examUploads.push({
			key: fullKey,
			path: join(SCRATCH_DIR, fullFile),
			contentType: "image/webp",
		});

		const shortCode = SHORT_CODE[ra.key];
		const dxId = rawToDx.get(`${ra.key}::${ra.n}`)!;
		questionRows.push({
			id: `exam-${shortCode}-${pageStr}`,
			dx_id: dxId,
			source: "exam",
			source_ref: `${deckFile}#${page}`,
			source_url: null,
			attribution: null,
			image_key_view: viewKey,
			image_key_full: fullKey,
			prompt: promptFor(dxId),
			image_note: null,
		});
	}
	console.log(
		`\n☁️  Uploading ${examUploads.length} exam images to R2 (${mode})…`,
	);
	await runPool(examUploads, 1, async (t) => {
		await r2Put(t.key, t.path, t.contentType, remote, force);
	});
	const examUploadCount = examUploads.length;
	console.log(
		`✓ ${questionRows.length} exam questions ready (${examUploadCount} R2 objects).`,
	);

	// ---------- Step: ASH images ----------
	// Decision: ASH originals are ~40–60KB JPGs (per index.jsonl `size`), well
	// under both the 1600px and 2400px WebP targets for exam pages — resizing
	// them into two WebP variants would add PIL scripting for no real benefit.
	// Upload once as the original JPG and point BOTH image_key_view and
	// image_key_full at that same key. (See report for reasoning.)
	const ashUploads: UploadTask[] = [];
	for (const [dxId, ids] of Object.entries(ashMap)) {
		for (const ashId of ids) {
			const { entry, path } = ashResolved.get(ashId)!;
			const ext = entry.image_file.includes(".")
				? entry.image_file.split(".").pop()!
				: "jpg";
			const key = `smear/ash/${ashId}.${ext}`;
			const contentType = ext === "png" ? "image/png" : "image/jpeg";
			ashUploads.push({ key, path, contentType });

			// id keys off (dxId, ashId), not just ashId: ash-map.json legitimately
			// lists the same ASH image under more than one dx when the reference
			// image is relevant to both (e.g. ALL-L3 / Burkitt lymphoma share
			// morphology) — `ash-${ashId}` alone collided on smear_questions'
			// PRIMARY KEY for those pairs.
			questionRows.push({
				id: `ash-${dxId}-${ashId}`,
				dx_id: dxId,
				source: "ash",
				source_ref: ashId,
				source_url: entry.url ?? null,
				attribution: entry.author ?? null,
				image_key_view: key,
				image_key_full: key,
				prompt: promptFor(dxId),
				image_note: null,
			});
		}
	}
	console.log(
		`\n☁️  Uploading ${ashUploads.length} ASH images to R2 (${mode})…`,
	);
	await runPool(ashUploads, 1, async (t) => {
		await r2Put(t.key, t.path, t.contentType, remote, force);
	});
	const ashUploadCount = ashUploads.length;
	console.log(
		`✓ ${ashUploadCount} ASH questions ready (${ashUploadCount} R2 objects).`,
	);

	// ---------- Step: smear_terms rows ----------
	type TermRow = {
		id: string;
		dx_id: string;
		text: string;
		norm: string;
		tier: Tier;
		form: Form;
	};
	const termRows: TermRow[] = [];
	let dupSkipped = 0;
	for (const dx of dxList) {
		// smear_terms has UNIQUE(dx_id, norm) — the runtime tombstone flow
		// (rejected-term resubmission) relies on that constraint to hold at
		// all times, including right after import. A few dx in dx.json list
		// near-duplicate spelling variants that normalizeTerm() collapses to
		// the same string (e.g. "AML, M2" / "AML-M2"), which would otherwise
		// crash the insert. Keep the first-listed spelling per dx and drop
		// the rest rather than pick a "more correct" one.
		const seenNorms = new Set<string>();
		dx.terms.forEach((t, idx) => {
			const norm = normalizeTerm(t.text);
			if (seenNorms.has(norm)) {
				dupSkipped++;
				return;
			}
			seenNorms.add(norm);
			termRows.push({
				id: `${dx.dx_id}-t${idx}`,
				dx_id: dx.dx_id,
				text: t.text,
				norm,
				tier: t.tier,
				form: t.form,
			});
		});
	}
	console.log(
		`\n✓ ${termRows.length} terms across ${dxList.length} dx.` +
			(dupSkipped > 0 ? ` (${dupSkipped} duplicate-norm variant(s) dropped)` : ""),
	);

	// ---------- Step: FTS rows ----------
	const now = Date.now();
	const dxNoteById = new Map(dxNotes.map((n) => [n.dx_id, n]));
	const termsByDx = new Map<string, string[]>();
	for (const t of termRows) {
		const arr = termsByDx.get(t.dx_id) ?? [];
		arr.push(t.text);
		termsByDx.set(t.dx_id, arr);
	}

	// ---------- Build one big SQL file, delete-then-insert, in chunks ----------
	const CHUNK = 50;
	const files: string[] = [];
	let fileIdx = 0;
	async function flush(statements: string[]) {
		if (statements.length === 0) return;
		const path = `/tmp/smear-import-${fileIdx++}.sql`;
		await writeFile(path, statements.join("\n"), "utf-8");
		files.push(path);
	}

	// Deletes — explicit, reverse dependency order. Written as their own
	// chunk so they always run before any insert, regardless of chunk size.
	await flush([
		"DELETE FROM smear_fts;",
		"DELETE FROM smear_answers;",
		"DELETE FROM smear_sessions;",
		"DELETE FROM smear_term_votes;",
		"DELETE FROM smear_terms;",
		"DELETE FROM smear_dx_notes;",
		"DELETE FROM smear_questions;",
		"DELETE FROM smear_dx;",
	]);

	// smear_dx
	for (let i = 0; i < dxList.length; i += CHUNK) {
		const chunk = dxList.slice(i, i + CHUNK);
		await flush(
			chunk.map(
				(d) =>
					`INSERT INTO smear_dx (id, canonical_long, canonical_abbrev, topic, qtype, created_at) VALUES ` +
					`('${esc(d.dx_id)}', '${esc(d.canonical_long)}', ${sqlStr(d.canonical_abbrev)}, '${esc(d.topic)}', '${esc(d.qtype)}', ${now});`,
			),
		);
	}

	// smear_terms
	for (let i = 0; i < termRows.length; i += CHUNK) {
		const chunk = termRows.slice(i, i + CHUNK);
		await flush(
			chunk.map(
				(t) =>
					`INSERT INTO smear_terms (id, dx_id, text, norm, tier, form, status, rationale, proposed_by, created_at, resolved_at) VALUES ` +
					`('${esc(t.id)}', '${esc(t.dx_id)}', '${esc(t.text)}', '${esc(t.norm)}', '${esc(t.tier)}', '${esc(t.form)}', 'accepted', NULL, NULL, ${now}, NULL);`,
			),
		);
	}

	// smear_questions (exam + ash)
	for (let i = 0; i < questionRows.length; i += CHUNK) {
		const chunk = questionRows.slice(i, i + CHUNK);
		await flush(
			chunk.map(
				(q) =>
					`INSERT INTO smear_questions (id, dx_id, source, source_ref, source_url, attribution, image_key_view, image_key_full, prompt, image_note, created_at) VALUES ` +
					`('${esc(q.id)}', '${esc(q.dx_id)}', '${esc(q.source)}', ${sqlStr(q.source_ref)}, ${sqlStr(q.source_url)}, ${sqlStr(q.attribution)}, '${esc(q.image_key_view)}', '${esc(q.image_key_full)}', ${sqlStr(q.prompt)}, ${sqlStr(q.image_note)}, ${now});`,
			),
		);
	}

	// smear_dx_notes
	for (let i = 0; i < dxNotes.length; i += CHUNK) {
		const chunk = dxNotes.slice(i, i + CHUNK);
		await flush(
			chunk.map((n) => {
				const contentJson = JSON.stringify(n.content_json);
				const relatedIds =
					n.related_dx_ids && n.related_dx_ids.length > 0
						? JSON.stringify(n.related_dx_ids)
						: null;
				return (
					`INSERT INTO smear_dx_notes (dx_id, content_json, related_dx_ids, version, updated_by, updated_at, editing_by, editing_until) VALUES ` +
					`('${esc(n.dx_id)}', '${esc(contentJson)}', ${sqlStr(relatedIds)}, 1, NULL, ${now}, NULL, NULL);`
				);
			}),
		);
	}

	// smear_fts
	const ftsRows = dxList.map((dx) => {
		const note = dxNoteById.get(dx.dx_id);
		const noteText = note ? extractPlainText(note.content_json) : "";
		const canonical = [dx.canonical_long, dx.canonical_abbrev]
			.filter(Boolean)
			.join(" ");
		const terms = (termsByDx.get(dx.dx_id) ?? []).join(" ");
		return {
			dx_id: dx.dx_id,
			canonical,
			terms,
			topic: dx.topic,
			note: noteText,
		};
	});
	for (let i = 0; i < ftsRows.length; i += CHUNK) {
		const chunk = ftsRows.slice(i, i + CHUNK);
		await flush(
			chunk.map(
				(r) =>
					`INSERT INTO smear_fts (dx_id, canonical, terms, topic, note) VALUES ` +
					`('${esc(r.dx_id)}', '${esc(r.canonical)}', '${esc(r.terms)}', '${esc(r.topic)}', '${esc(r.note)}');`,
			),
		);
	}

	console.log(`\n💾 Writing ${files.length} SQL chunk(s) to D1 (${mode})…`);
	for (const f of files) {
		await shRetry("wrangler", ["d1", "execute", D1_DB, mode, "--file", f]);
	}

	// ---------- Summary ----------
	console.log("\n✅ Import complete.");
	console.log(`   smear_dx:        ${dxList.length}`);
	console.log(`   smear_terms:     ${termRows.length}`);
	console.log(
		`   smear_questions: ${questionRows.length} (exam=${examUploadCount / 2}, ash=${ashUploadCount})`,
	);
	console.log(`   smear_dx_notes:  ${dxNotes.length}`);
	console.log(`   smear_fts:       ${ftsRows.length}`);
}

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------

/** Reads DECK_MAP directly from parse_answers.py — never duplicate the mapping. */
async function loadDeckMap(): Promise<Record<string, string>> {
	const { stdout } = await execFileP(
		"python3",
		[
			"-c",
			"import json; from parse_answers import DECK_MAP; print(json.dumps(DECK_MAP))",
		],
		{ cwd: SMEAR_DIR },
	);
	return JSON.parse(stdout);
}

/** Parses ~/ash-image-bank/data/index.jsonl into a Map keyed by ASH image id. */
async function loadAshIndex(): Promise<Map<string, AshIndexEntry>> {
	const raw = await readFile(ASH_INDEX_PATH, "utf-8");
	const map = new Map<string, AshIndexEntry>();
	for (const line of raw.split("\n")) {
		const t = line.trim();
		if (!t) continue;
		const r = JSON.parse(t);
		map.set(r.id, r);
	}
	return map;
}

/** Walks a TipTap doc, concatenating all `type: 'text'` node text with spaces. */
function extractPlainText(node: unknown): string {
	const out: string[] = [];
	function walk(n: any) {
		if (!n || typeof n !== "object") return;
		if (n.type === "text" && typeof n.text === "string") out.push(n.text);
		if (Array.isArray(n.content)) for (const c of n.content) walk(c);
	}
	walk(node);
	return out.join(" ").replace(/\s+/g, " ").trim();
}

function esc(s: string): string {
	return s.replace(/'/g, "''");
}

/** SQL literal for a nullable string column: NULL or a quoted/escaped string. */
function sqlStr(s: string | null | undefined): string {
	return s == null ? "NULL" : `'${esc(s)}'`;
}

/** Runs `fn` over `items` with at most `concurrency` in flight at once. */
async function runPool<T>(
	items: T[],
	concurrency: number,
	fn: (item: T) => Promise<void>,
): Promise<void> {
	let next = 0;
	let done = 0;
	const total = items.length;
	async function worker() {
		while (next < items.length) {
			const i = next++;
			await fn(items[i]);
			done++;
			if (done % 40 === 0 || done === total)
				console.log(`   ... ${done}/${total}`);
		}
	}
	await Promise.all(
		Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
	);
}

function sh(cmd: string, args: string[]): Promise<void> {
	return new Promise((resolveP, reject) => {
		const p = spawn(cmd, args, { stdio: "inherit" });
		p.on("exit", (code) =>
			code === 0 ? resolveP() : reject(new Error(`${cmd} exited ${code}`)),
		);
		p.on("error", reject);
	});
}

/** Same as `sh`, but retries a few times with backoff — see r2Put's comment
 * for why the local Workers runtime is flaky under repeated CLI invocation. */
async function shRetry(cmd: string, args: string[], maxAttempts = 3): Promise<void> {
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			await sh(cmd, args);
			return;
		} catch (e) {
			if (attempt >= maxAttempts) throw e;
			console.error(`   ⚠ ${cmd} ${args.join(" ")} failed (attempt ${attempt}), retrying…`);
			await sleep(500 * attempt);
		}
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

/**
 * Runs `wrangler r2 object put`, capturing output (quiet on success, printed
 * on failure). Retries on failure with backoff.
 *
 * ⚠️ Local `--local` R2 puts each spin up a short-lived Miniflare/workerd
 * process against the same file-backed sqlite store under .wrangler/state.
 * That combination is flaky even at modest concurrency — observed both
 * `SQLITE_BUSY (SQLITE_BUSY_RECOVERY)` crashes (concurrency=8) and
 * "Network connection lost" (concurrency=3) on an otherwise-valid put, with
 * no pattern pointing at a real data problem (retrying the exact same
 * command succeeds). Uploads therefore run at concurrency=1 (see call
 * sites) and this retries on ANY failure, not just a matched error string —
 * enumerating wrangler's local-runtime crash signatures is a losing game,
 * and a genuinely bad put (missing file, wrong bucket) will fail identically
 * on every attempt and still surface once maxAttempts is exhausted.
 */
async function r2Put(
	key: string,
	filePath: string,
	contentType: string,
	remote: boolean,
	force: boolean,
): Promise<void> {
	if (!force && (await r2ObjectExists(`${R2_BUCKET}/${key}`, remote))) {
		console.log(`⏭ skip upload ${key} (exists)`);
		return;
	}
	const args = [
		"r2",
		"object",
		"put",
		`${R2_BUCKET}/${key}`,
		"--file",
		filePath,
		"--content-type",
		contentType,
		remote ? "--remote" : "--local",
	];
	const maxAttempts = 6;
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			await execFileP("wrangler", args);
			return;
		} catch (e: any) {
			if (attempt < maxAttempts) {
				await sleep(400 * attempt + Math.floor(Math.random() * 400));
				continue;
			}
			console.error(
				`\n❌ wrangler r2 object put failed for ${key} (attempt ${attempt}):\n${e.stdout ?? ""}\n${e.stderr ?? ""}`,
			);
			throw e;
		}
	}
}

/**
 * Returns true if the R2 object already exists. Uses `wrangler r2 object get`
 * to /dev/null and inspects the exit code (non-zero = missing/error). Mirrors
 * scripts/import-lectures.ts's r2ObjectExists() for consistency.
 */
function r2ObjectExists(objRef: string, remote: boolean): Promise<boolean> {
	return new Promise((resolve) => {
		const args = [
			"r2",
			"object",
			"get",
			objRef,
			"--file",
			"/dev/null",
			remote ? "--remote" : "--local",
		];
		const p = spawn("wrangler", args, { stdio: "ignore" });
		p.on("exit", (code) => resolve(code === 0));
		p.on("error", () => resolve(false));
	});
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});

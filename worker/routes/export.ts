import { Hono } from "hono";
import type { AppContext } from "../types";
import {
	parseScope,
	scopeLabel,
	scopeSql,
	filenameFor,
	MAX_QUESTIONS,
	type ExportScope,
} from "../lib/export-scope.ts";
import {
	renderExportMarkdown,
	contentDisposition,
	type ExportItem,
	type ExportOption,
} from "../lib/export-doc.ts";
import { extractHighlightTexts } from "../lib/tiptap-render.ts";
import { renderExportCsv } from "../lib/export-csv.ts";
import { renderExportHtml } from "../lib/export-html.ts";
import { collectImageKeys, planEmbed, fetchEmbeds } from "../lib/export-images.ts";

// 「把我選的範圍帶著走」 — Markdown / Anki CSV / 單檔 HTML.
//
// PRIVACY: every query below is scoped to c.var.email. The request body only
// ever says *which* scope, never *whose* — see worker/lib/export-scope.ts.
//
// Non-goals (see docs/plans/2026-07-20-in-app-export.md): .apkg and PDF.
// scripts/build-anki.py keeps producing the full-year decks offline.
export const exportRoutes = new Hono<AppContext>();

type Format = "md" | "csv" | "html";
type Include = { explanation: boolean; note: boolean; highlights: boolean };

function parseInclude(raw: unknown): Include {
	const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
	const on = (v: unknown) => v !== false; // default true
	return { explanation: on(o.explanation), note: on(o.note), highlights: on(o.highlights) };
}

function parseJson(s: unknown): unknown {
	if (typeof s !== "string" || !s) return null;
	try {
		return JSON.parse(s);
	} catch {
		return null;
	}
}

// Resolve the display name of a bookmark folder — scoped to the caller, so an
// unknown / someone else's folder id just yields the generic label (and the
// scope query itself returns nothing).
async function folderNameFor(
	db: D1Database,
	scope: ExportScope,
	email: string,
): Promise<string | null> {
	if (scope.kind !== "folder" || scope.folder_id === null) return null;
	const row = await db
		.prepare("SELECT name FROM bookmark_folders WHERE id = ? AND user_email = ?")
		.bind(scope.folder_id, email)
		.first<{ name: string }>();
	return row?.name ?? null;
}

// D1 rejects a statement with too many bound parameters ("too many SQL
// variables"), so any `… IN (?, ?, …)` over an id list has to be chunked.
// MAX_QUESTIONS is 200, comfortably above the limit. 90 leaves room for the
// email / filter params that ride along in the same statement.
const D1_MAX_PARAMS = 90;

function chunk<T>(arr: T[], size: number): T[][] {
	if (arr.length <= size) return [arr];
	const out: T[][] = [];
	for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
	return out;
}

async function resolveIds(
	db: D1Database,
	scope: ExportScope,
	email: string,
): Promise<string[]> {
	// The `ids` scope is the only one that binds a caller-sized list.
	const scopes: ExportScope[] =
		scope.kind === "ids"
			? chunk(scope.ids, D1_MAX_PARAMS).map((ids) => ({ ...scope, ids }))
			: [scope];

	const seen = new Set<string>();
	const out: string[] = [];
	for (const s of scopes) {
		const { sql, params } = scopeSql(s, email);
		const { results } = await db
			.prepare(sql)
			.bind(...params)
			.all<{ id: string }>();
		for (const r of results ?? []) {
			if (r?.id && !seen.has(r.id)) {
				seen.add(r.id);
				out.push(r.id);
			}
		}
	}
	return out;
}

// Run one `… IN (?)` query per id chunk and concatenate the rows.
async function allChunked<T>(
	db: D1Database,
	ids: string[],
	build: (holes: string) => string,
	lead: unknown[] = [],
): Promise<T[]> {
	const out: T[] = [];
	for (const part of chunk(ids, D1_MAX_PARAMS - lead.length)) {
		const { results } = await db
			.prepare(build(part.map(() => "?").join(",")))
			.bind(...lead, ...part)
			.all<T>();
		out.push(...((results ?? []) as T[]));
	}
	return out;
}

type QuestionRow = {
	id: string;
	year: number;
	number: number;
	stem: string;
	group: string | null;
	options_json: string;
	answer: string;
};

// 5 batched queries, no N+1. `personal_notes` and `highlights` are the two
// private tables — both filtered by user_email BEFORE the id filter.
async function loadItems(
	db: D1Database,
	ids: string[],
	email: string,
	include: Include,
): Promise<ExportItem[]> {
	type DocRow = { question_id: string; content_json: string };

	const [qRows, eRows, tRows, nRows, hRes] = await Promise.all([
		allChunked<QuestionRow>(
			db,
			ids,
			(holes) => `SELECT id, year, number, stem, "group", options_json, answer
         FROM questions WHERE id IN (${holes})`,
		),
		include.explanation
			? allChunked<DocRow>(
					db,
					ids,
					(holes) =>
						`SELECT question_id, content_json FROM explanations WHERE question_id IN (${holes})`,
				)
			: Promise.resolve([] as DocRow[]),
		allChunked<{ question_id: string; tag: string }>(
			db,
			ids,
			(holes) => `SELECT question_id, tag FROM question_tags
         WHERE question_id IN (${holes}) ORDER BY created_at ASC`,
		),
		include.note
			? allChunked<DocRow>(
					db,
					ids,
					(holes) => `SELECT question_id, content_json FROM personal_notes
             WHERE user_email = ? AND question_id IN (${holes})`,
					[email],
				)
			: Promise.resolve([] as DocRow[]),
		// Highlights are keyed by store_key, not question_id, so we take this
		// user's rows and match qids in memory (one person's highlight set is
		// small). The user_email filter is still done in SQL.
		include.highlights
			? db
					.prepare("SELECT store_key, doc_json FROM highlights WHERE user_email = ?")
					.bind(email)
					.all<{ store_key: string; doc_json: string }>()
			: Promise.resolve({ results: [] as { store_key: string; doc_json: string }[] }),
	]);

	const byId = new Map<string, QuestionRow>();
	for (const q of qRows) byId.set(q.id, q);

	const explById = new Map<string, unknown>();
	for (const e of eRows) explById.set(e.question_id, parseJson(e.content_json));

	const tagsById = new Map<string, string[]>();
	for (const t of tRows) {
		const list = tagsById.get(t.question_id) ?? [];
		list.push(t.tag);
		tagsById.set(t.question_id, list);
	}

	// 一題可以有多則筆記(migration 0036)。匯出的格式一題只放一份文件,所以
	// 把它們接成一份,中間用分隔線 —— 少放任何一則都是靜靜地漏資料。
	const noteById = new Map<string, unknown>();
	for (const n of nRows) {
		const doc = parseJson(n.content_json) as { content?: unknown[] } | null;
		const blocks = Array.isArray(doc?.content) ? doc.content : [];
		const prev = noteById.get(n.question_id) as { content?: unknown[] } | undefined;
		if (!prev) {
			noteById.set(n.question_id, { type: "doc", content: blocks });
		} else {
			prev.content = [...(prev.content ?? []), { type: "horizontalRule" }, ...blocks];
		}
	}

	const wanted = new Set(ids);
	const hlById = new Map<string, string[]>();
	for (const h of hRes.results ?? []) {
		const qid = questionIdOfStoreKey(h.store_key);
		if (!qid || !wanted.has(qid)) continue;
		const texts = extractHighlightTexts(parseJson(h.doc_json));
		if (texts.length === 0) continue;
		const list = hlById.get(qid) ?? [];
		for (const t of texts) if (!list.includes(t)) list.push(t);
		hlById.set(qid, list);
	}

	const items: ExportItem[] = [];
	for (const id of ids) {
		const q = byId.get(id);
		if (!q) continue; // id no longer exists — skip rather than fabricate
		items.push({
			id: q.id,
			year: q.year,
			number: q.number,
			group: q.group,
			stem: q.stem,
			options: parseOptions(q.options_json),
			answer: q.answer,
			tags: tagsById.get(id) ?? [],
			explanation: explById.get(id) ?? null,
			note: noteById.get(id) ?? null,
			highlights: hlById.get(id) ?? [],
		});
	}
	return items;
}

// 'anno:exp:<qid>' | 'anno:note:<qid>:<hash>' — see
// frontend/src/routes/Question.tsx and frontend/src/lib/noteHighlights.ts.
export function questionIdOfStoreKey(key: string): string | null {
	if (typeof key !== "string") return null;
	if (key.startsWith("anno:exp:")) return key.slice("anno:exp:".length) || null;
	if (key.startsWith("anno:note:")) {
		const rest = key.slice("anno:note:".length);
		const cut = rest.indexOf(":");
		return (cut === -1 ? rest : rest.slice(0, cut)) || null;
	}
	return null;
}

function parseOptions(json: string): ExportOption[] {
	const parsed = parseJson(json);
	if (!Array.isArray(parsed)) return [];
	return parsed
		.filter((o) => o && typeof o === "object")
		.map((o: any) => ({ key: String(o.key ?? ""), text: String(o.text ?? "") }))
		.filter((o) => o.key !== "");
}

// Absolute origin for image / question links in the exported file (Anki and a
// downloaded .md have no notion of our site root). Derived from the request,
// or pinned by PUBLIC_HOST — never hard-coded. The scheme is forced to https
// for anything but a loopback host: `wrangler dev` reports the configured
// route host with an http: scheme, which would bake a broken URL into the
// file.
export function originOf(c: { req: { url: string }; env: { PUBLIC_HOST?: string } }): string {
	if (c.env.PUBLIC_HOST) return `https://${c.env.PUBLIC_HOST}`;
	const url = new URL(c.req.url);
	const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(url.hostname);
	return local ? url.origin : `https://${url.host}`;
}

// POST /api/export/preview — { scope } → { count, ids, label, truncated, max }
exportRoutes.post("/preview", async (c) => {
	const body = await c.req.json<{ scope?: unknown }>().catch(() => ({}) as any);
	const parsed = parseScope(body?.scope);
	if (!parsed.scope) return c.json({ error: parsed.error }, 400);

	const email = c.var.email;
	const folderName = await folderNameFor(c.env.DB, parsed.scope, email);
	const ids = await resolveIds(c.env.DB, parsed.scope, email);
	return c.json({
		count: ids.length,
		ids,
		label: scopeLabel(parsed.scope, folderName),
		truncated: parsed.truncated,
		max: MAX_QUESTIONS,
	});
});

// POST /api/export — { scope, format, include, embed_images } → file download
exportRoutes.post("/", async (c) => {
	const body = await c.req
		.json<{ scope?: unknown; format?: unknown; include?: unknown; embed_images?: unknown }>()
		.catch(() => ({}) as any);

	const parsed = parseScope(body?.scope);
	if (!parsed.scope) return c.json({ error: parsed.error }, 400);
	const scope = parsed.scope;

	const format: Format =
		body?.format === "csv" ? "csv" : body?.format === "html" ? "html" : "md";
	const include = parseInclude(body?.include);
	const email = c.var.email;
	const now = Date.now();

	const folderName = await folderNameFor(c.env.DB, scope, email);
	const ids = await resolveIds(c.env.DB, scope, email);
	if (ids.length === 0) return c.json({ error: "empty scope" }, 400);
	if (ids.length > MAX_QUESTIONS) {
		return c.json({ error: "too many", count: ids.length, max: MAX_QUESTIONS }, 413);
	}

	const items = await loadItems(c.env.DB, ids, email, include);
	const label = scopeLabel(scope, folderName);
	const origin = originOf(c);
	const footnotes: string[] = [];

	// Optional base64 embedding (md / html only — Anki won't fetch remote
	// images, and a data: URI inside a CSV cell bloats the file for no gain).
	let imageSrc: ((src: string) => string | null) | undefined;
	if (body?.embed_images === true && format !== "csv") {
		const keys = collectImageKeys(items);
		const { embed, skipped } = planEmbed(keys);
		const map = await fetchEmbeds(c.env.R2, embed);
		if (skipped.length > 0 || map.size < embed.length) {
			const missed = skipped.length + (embed.length - map.size);
			footnotes.push(`${missed} 張圖片因體積上限或讀取失敗未內嵌,仍以連結呈現。`);
		}
		imageSrc = (src) => map.get(src) ?? absolutise(src, origin);
	} else {
		// Always absolute: a relative /img/ link is useless once the file leaves
		// the app. The bucket stays private — these still go through the worker
		// proxy and need a Cloudflare Access session.
		imageSrc = (src) => absolutise(src, origin);
	}

	const renderOpts = { imageSrc, questionRefBase: `${origin}/q/` };

	let payload: string;
	let mime: string;
	if (format === "csv") {
		// Excel needs the BOM to read UTF-8; Anki tolerates it.
		payload = `﻿${renderExportCsv(items, { origin })}`;
		mime = "text/csv; charset=utf-8";
	} else if (format === "html") {
		payload = renderExportHtml(items, { label, email, now, footnotes }, renderOpts);
		mime = "text/html; charset=utf-8";
	} else {
		payload = renderExportMarkdown(items, { label, email, now, footnotes }, renderOpts);
		mime = "text/markdown; charset=utf-8";
	}

	return new Response(payload, {
		headers: {
			"Content-Type": mime,
			"Content-Disposition": contentDisposition(
				filenameFor(scope, format, { folderName, now }),
			),
			"Cache-Control": "no-store",
		},
	});
});

function absolutise(src: string, origin: string): string {
	return src.startsWith("/") ? origin + src : src;
}

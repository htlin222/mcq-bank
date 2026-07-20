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

async function resolveIds(
	db: D1Database,
	scope: ExportScope,
	email: string,
): Promise<string[]> {
	const { sql, params } = scopeSql(scope, email);
	const { results } = await db
		.prepare(sql)
		.bind(...params)
		.all<{ id: string }>();
	const seen = new Set<string>();
	const out: string[] = [];
	for (const r of results ?? []) {
		if (r?.id && !seen.has(r.id)) {
			seen.add(r.id);
			out.push(r.id);
		}
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
	const holes = ids.map(() => "?").join(",");

	const [qRes, eRes, tRes, nRes, hRes] = await Promise.all([
		db
			.prepare(
				`SELECT id, year, number, stem, "group", options_json, answer
         FROM questions WHERE id IN (${holes})`,
			)
			.bind(...ids)
			.all<QuestionRow>(),
		include.explanation
			? db
					.prepare(
						`SELECT question_id, content_json FROM explanations WHERE question_id IN (${holes})`,
					)
					.bind(...ids)
					.all<{ question_id: string; content_json: string }>()
			: Promise.resolve({ results: [] as { question_id: string; content_json: string }[] }),
		db
			.prepare(
				`SELECT question_id, tag FROM question_tags
         WHERE question_id IN (${holes}) ORDER BY created_at ASC`,
			)
			.bind(...ids)
			.all<{ question_id: string; tag: string }>(),
		include.note
			? db
					.prepare(
						`SELECT question_id, content_json FROM personal_notes
             WHERE user_email = ? AND question_id IN (${holes})`,
					)
					.bind(email, ...ids)
					.all<{ question_id: string; content_json: string }>()
			: Promise.resolve({ results: [] as { question_id: string; content_json: string }[] }),
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
	for (const q of qRes.results ?? []) byId.set(q.id, q);

	const explById = new Map<string, unknown>();
	for (const e of eRes.results ?? []) explById.set(e.question_id, parseJson(e.content_json));

	const tagsById = new Map<string, string[]>();
	for (const t of tRes.results ?? []) {
		const list = tagsById.get(t.question_id) ?? [];
		list.push(t.tag);
		tagsById.set(t.question_id, list);
	}

	const noteById = new Map<string, unknown>();
	for (const n of nRes.results ?? []) noteById.set(n.question_id, parseJson(n.content_json));

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

// Absolute origin for image URLs in CSV (Anki has no notion of our site root).
// Taken from the request unless PUBLIC_HOST pins it — never hard-coded.
function originOf(c: { req: { url: string }; env: { PUBLIC_HOST?: string } }): string {
	if (c.env.PUBLIC_HOST) return `https://${c.env.PUBLIC_HOST}`;
	return new URL(c.req.url).origin;
}

// POST /api/export/preview — { scope } → { count, ids, label, truncated, max }
exportRoutes.post("/preview", async (c) => {
	const body = await c.req.json<{ scope?: unknown }>().catch(() => ({}) as any);
	const parsed = parseScope(body?.scope);
	if (parsed.error) return c.json({ error: parsed.error }, 400);

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
	if (parsed.error) return c.json({ error: parsed.error }, 400);
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
	} else if (format !== "md") {
		imageSrc = (src) => absolutise(src, origin);
	}

	const renderOpts = { imageSrc, questionRefBase: `${origin}/q/` };

	let payload: string;
	let mime: string;
	if (format === "csv") {
		// Excel needs the BOM to read UTF-8; Anki tolerates it.
		payload = `﻿${renderExportCsv(items, { origin, label })}`;
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

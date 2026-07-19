import { Hono } from "hono";
import type { AppContext } from "../types";

// Server-backed 畫記 (highlights) so a user's 螢光標記 follow them across
// devices. Per-user, keyed by store_key (the same key the client used for
// localStorage). doc_json is the annotated TipTap doc; content_hash guards
// staleness; updated_at drives last-write-wins reconciliation on the client.
export const highlightsRoutes = new Hono<AppContext>();

const MAX_DOC = 200_000; // ~200KB per highlight blob — guards runaway payloads

// GET /api/highlights[?prefix=anno:note:] — list this user's highlights.
highlightsRoutes.get("/", async (c) => {
	const email = c.var.email;
	const prefix = c.req.query("prefix");
	const sql =
		"SELECT store_key, content_hash, doc_json, updated_at FROM highlights WHERE user_email = ?" +
		(prefix ? " AND store_key LIKE ?" : "") +
		" ORDER BY updated_at DESC";
	const stmt = prefix
		? c.env.DB.prepare(sql).bind(email, `${prefix}%`)
		: c.env.DB.prepare(sql).bind(email);
	const { results } = await stmt.all();
	return c.json(results ?? []);
});

// GET /api/highlights/one?key=<store_key> — single row or null.
highlightsRoutes.get("/one", async (c) => {
	const email = c.var.email;
	const key = c.req.query("key");
	if (!key) return c.json(null);
	const row = await c.env.DB.prepare(
		"SELECT store_key, content_hash, doc_json, updated_at FROM highlights WHERE user_email = ? AND store_key = ?",
	)
		.bind(email, key)
		.first();
	return c.json(row ?? null);
});

// PUT /api/highlights — upsert one highlight blob.
highlightsRoutes.put("/", async (c) => {
	const email = c.var.email;
	const body = await c.req.json<{
		store_key?: string;
		content_hash?: string;
		doc_json?: string;
		updated_at?: number;
	}>();
	const { store_key, content_hash, doc_json } = body;
	if (!store_key || !content_hash || typeof doc_json !== "string") {
		return c.json({ error: "store_key, content_hash, doc_json required" }, 400);
	}
	if (doc_json.length > MAX_DOC) return c.json({ error: "doc too large" }, 413);
	const updated_at =
		typeof body.updated_at === "number" ? body.updated_at : Date.now();

	await c.env.DB.prepare(
		`INSERT INTO highlights (user_email, store_key, content_hash, doc_json, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_email, store_key) DO UPDATE SET
       content_hash = excluded.content_hash,
       doc_json = excluded.doc_json,
       updated_at = excluded.updated_at`,
	)
		.bind(email, store_key, content_hash, doc_json, updated_at)
		.run();

	return c.json({ ok: true, updated_at });
});

// DELETE /api/highlights?key=<store_key> — remove one (e.g. user cleared all
// marks on a doc).
highlightsRoutes.delete("/", async (c) => {
	const email = c.var.email;
	const key = c.req.query("key");
	if (!key) return c.json({ error: "key required" }, 400);
	await c.env.DB.prepare(
		"DELETE FROM highlights WHERE user_email = ? AND store_key = ?",
	)
		.bind(email, key)
		.run();
	return c.json({ ok: true });
});

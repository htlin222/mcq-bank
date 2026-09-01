import { Hono } from "hono";
import { parseTagList } from "../lib/sql-params";
import { QUESTION_ROW_COLUMNS, toQuestionRow } from "../lib/question-row";
import type { AppContext } from "../types";

export const searchRoutes = new Hono<AppContext>();

/**
 * GET /api/search
 *   ?q=       full-text query (FTS5 syntax allowed — quotes for phrases,
 *             AND/OR/NOT operators; bare terms are AND'd by FTS5 defaults)
 *   ?year=    filter by 民國 year
 *   ?group=   filter by one of the labels from config.toml [groups].list
 *   ?tags=    comma-separated tags, AND-semantics
 *   ?sort=    relevance (default) | year
 *   ?answered= all (default) | yes | no  — per-user answered state
 *   ?limit=   default 30, max 100
 *   ?offset=  default 0
 *
 * Returns items with snippet/highlight, bm25 rank, and the caller's
 * per-question review state (times_seen / last_correct). A non-empty `q`
 * is also recorded into the caller's search_history (upsert, deduped).
 */
searchRoutes.get("/", async (c) => {
	const email = c.var.email;
	const q = (c.req.query("q") || "").trim();
	const year = c.req.query("year");
	const group = c.req.query("group");
	const tags = c.req.query("tags");
	const sort = c.req.query("sort") === "year" ? "year" : "relevance";
	const answeredRaw = c.req.query("answered");
	const answered =
		answeredRaw === "yes" || answeredRaw === "no" ? answeredRaw : "all";
	const limit = Math.min(parseInt(c.req.query("limit") || "30"), 100);
	const offset = parseInt(c.req.query("offset") || "0");

	if (!q && !year && !group && !tags) {
		return c.json({ items: [], total: 0, q });
	}

	// Params are pushed in the EXACT textual order the `?` placeholders appear
	// in the final SQL below (JOIN → WHERE → LIMIT), so positional binding stays
	// correct even when several filters combine.
	const params: any[] = [];

	const joinFts = q ? "JOIN questions_fts f ON f.rowid = q.rowid" : "";

	// Per-user answered state via LEFT JOIN — placeholder for user_email sits in
	// the JOIN clause, so its param comes before any WHERE/tag params.
	const progressJoin =
		"LEFT JOIN review_progress rp ON rp.question_id = q.id AND rp.user_email = ?";
	params.push(email);

	let tagJoin = "";
	if (tags) {
		const list = parseTagList(tags);
		if (list.length > 0) {
			tagJoin = `
        JOIN (
          SELECT question_id FROM question_tags
          WHERE tag IN (${list.map(() => "?").join(",")})
          GROUP BY question_id
          HAVING COUNT(DISTINCT tag) = ?
        ) tf ON tf.question_id = q.id
      `;
			params.push(...list, list.length);
		}
	}

	const where: string[] = [];
	if (q) {
		// Escape FTS quotes; build a permissive prefix query for partial matches.
		where.push("questions_fts MATCH ?");
		params.push(ftsQuery(q));
	}
	if (year) {
		where.push("q.year = ?");
		params.push(parseInt(year));
	}
	if (group) {
		where.push('q."group" = ?');
		params.push(group);
	}
	if (answered === "yes") {
		where.push("(rp.times_seen IS NOT NULL AND rp.times_seen > 0)");
	} else if (answered === "no") {
		where.push("(rp.times_seen IS NULL OR rp.times_seen = 0)");
	}

	const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
	// bm25 relevance is only meaningful when an FTS query ran; without `q`, or
	// when the user explicitly picks 年份排序, fall back to year/number order.
	const orderSql =
		sort === "relevance" && q
			? "ORDER BY bm25(questions_fts) ASC, q.year DESC, q.number ASC"
			: "ORDER BY q.year DESC, q.number ASC";

	const snippetSelect = q
		? `, snippet(questions_fts, 1, '<<', '>>', '…', 16) AS snippet`
		: `, '' AS snippet`;

	// 列的形狀與另外三個清單端點共用(見 lib/question-row.ts)。
	const sql = `
    SELECT ${QUESTION_ROW_COLUMNS},
           rp.times_seen, rp.last_correct, rp.last_chosen ${snippetSelect}
    FROM questions q
    ${joinFts}
    ${progressJoin}
    ${tagJoin}
    ${whereSql}
    ${orderSql}
    LIMIT ? OFFSET ?
  `;
	params.push(limit, offset);

	try {
		const { results } = await c.env.DB.prepare(sql)
			.bind(...params)
			.all<{ options_json: string; answer: string }>();
		const items = (results ?? []).map(toQuestionRow);
		// Record the query for the recent-searches dropdown. Fire-and-forget: a
		// history write must never fail or delay the search response itself.
		if (q) {
			const write = c.env.DB.prepare(
				`INSERT INTO search_history (user_email, query, created_at)
         VALUES (?, ?, ?)
         ON CONFLICT(user_email, query) DO UPDATE SET created_at = excluded.created_at`,
			)
				.bind(email, q, Date.now())
				.run()
				.catch((e) => console.warn("search_history write failed:", String(e)));
			c.executionCtx.waitUntil(write);
		}
		return c.json({ items, q });
	} catch (e) {
		// Usually FTS5 syntax the user typed; log the specifics, keep the
		// response generic so SQL/schema detail never reaches the client.
		console.warn("search failed:", String(e));
		return c.json({ error: "search failed", q }, 400);
	}
});

/**
 * GET /api/search/history?limit=10
 * Recent distinct queries for the caller, newest first.
 */
searchRoutes.get("/history", async (c) => {
	const email = c.var.email;
	const limit = Math.min(parseInt(c.req.query("limit") || "10"), 50);
	const { results } = await c.env.DB.prepare(
		`SELECT query, created_at FROM search_history
     WHERE user_email = ?
     ORDER BY created_at DESC
     LIMIT ?`,
	)
		.bind(email, limit)
		.all();
	return c.json({ items: results });
});

/**
 * DELETE /api/search/history          → clear all of the caller's history
 * DELETE /api/search/history?query=x  → remove a single remembered query
 */
searchRoutes.delete("/history", async (c) => {
	const email = c.var.email;
	const query = c.req.query("query");
	if (query) {
		await c.env.DB.prepare(
			"DELETE FROM search_history WHERE user_email = ? AND query = ?",
		)
			.bind(email, query)
			.run();
	} else {
		await c.env.DB.prepare("DELETE FROM search_history WHERE user_email = ?")
			.bind(email)
			.run();
	}
	return c.json({ ok: true });
});

/**
 * Convert user input into an FTS5-safe query.
 *
 * - Replaces stray `"` characters with spaces so user tokens never break
 *   our own phrase quoting.
 * - Pure ASCII alnum tokens get a trailing `*` for prefix matching
 *   (e.g. `AML` → `AML*` matches `AML7`).
 * - Mixed / CJK tokens are wrapped in `"..."` so FTS5 treats them as
 *   literal phrases.
 * - FTS5 operators (AND / OR / NOT / parentheses / column filters) are
 *   intentionally NOT stripped — they're useful in the search box and
 *   only operate over our indexed columns (stem / options / tags),
 *   none of which leak private data.
 *
 * Safety: the returned string is always passed via `.bind(?)` so SQL
 * injection is not possible regardless of input.
 */
export function ftsQuery(raw: string): string {
	const cleaned = raw.replace(/"/g, " ").trim();
	if (!cleaned) return "";
	const parts = cleaned.split(/\s+/).map((t) => {
		if (/^[A-Za-z0-9_]+$/.test(t)) return `${t}*`;
		return `"${t}"`;
	});
	return parts.join(" ");
}

import { Hono } from "hono";
import { TEXT_MODEL } from "../lib/ai-models";
import { ftsQuery } from "../lib/fts-query";
import {
	MAX_QUERY_LEN,
	buildExpandSystemPrompt,
	parseExpandResponse,
} from "../lib/search-expand";
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

	// `q` 可能整串都是逗號 / 引號 / 空白 —— 那樣 ftsQuery 會回空字串,而
	// `MATCH ''` 是 FTS5 語法錯誤(路由把它變成 400「搜尋失敗」)。所以判斷
	// 「這次要不要走全文檢索」看的是**轉換之後**的字串,不是使用者原本打了什麼。
	const match = q ? ftsQuery(q) : "";
	if (!match && !year && !group && !tags) {
		return c.json({ items: [], total: 0, q });
	}

	// Params are pushed in the EXACT textual order the `?` placeholders appear
	// in the final SQL below (JOIN → WHERE → LIMIT), so positional binding stays
	// correct even when several filters combine.
	const params: any[] = [];

	const joinFts = match ? "JOIN questions_fts f ON f.rowid = q.rowid" : "";

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
	if (match) {
		where.push("questions_fts MATCH ?");
		params.push(match);
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
		sort === "relevance" && match
			? "ORDER BY bm25(questions_fts) ASC, q.year DESC, q.number ASC"
			: "ORDER BY q.year DESC, q.number ASC";

	const snippetSelect = match
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
 * POST /api/search/expand  { q }  →  { terms: string[] }
 *
 * 「AI 進階搜尋」:把一個關鍵字展開成一排寫法變體(縮寫 ↔ 全名、單複數、
 * 常見同義詞、中文對照),前端再用逗號串起來丟回 `/api/search` —— 逗號在
 * `lib/fts-query.ts` 就是 OR,所以這裡不需要碰查詢語法。
 *
 * **不寫入任何東西,也不記進 search_history** —— 這一步只是「幫你想關鍵字」,
 * 使用者按下搜尋之前它什麼都還沒發生。
 *
 * 失敗時回 503 而不是空陣列:前端要分得出「模型掛了」與「模型覺得沒有別的寫法」,
 * 後者是正常結果,前者該讓使用者知道可以自己手動加逗號。
 */
searchRoutes.post("/expand", async (c) => {
	const body = await c.req
		.json<{ q?: unknown }>()
		.catch(() => ({}) as { q?: unknown });
	const q = typeof body.q === "string" ? body.q.trim() : "";
	if (!q) return c.json({ error: "empty query" }, 400);
	// 這是要丟給模型的東西,不該變成貼一整段文章的入口。
	if (q.length > MAX_QUERY_LEN) return c.json({ error: "query too long" }, 400);

	try {
		const out = await c.env.AI.run(TEXT_MODEL, {
			messages: [
				{ role: "system", content: buildExpandSystemPrompt() },
				{ role: "user", content: q },
			],
		});
		return c.json({ terms: parseExpandResponse(out, q) });
	} catch (e) {
		// free tier 是每天 10K neurons,額度用完就是這條路。
		console.warn("search expand failed", String(e));
		return c.json({ error: "expand failed" }, 503);
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

// `worker/routes/mcq.ts` 從這裡拿 —— 實作已搬到 lib(純函式才進得了
// `node --test`),這一行只是不讓呼叫端跟著改。
export { ftsQuery };

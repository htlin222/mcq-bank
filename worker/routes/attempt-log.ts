import { Hono } from "hono";
import type { AppContext } from "../types";
import {
	parseAttemptFilters,
	buildAttemptWhere,
	renderAttemptCsv,
	exportFilename,
	MAX_EXPORT_ROWS,
	type AttemptLogRow,
} from "../lib/attempt-log.ts";
import { contentDisposition } from "../lib/export-doc.ts";

// 「答題狀態分析」—— 個人頁的長表下載。
//
// PRIVACY: 每一條查詢的 WHERE 都由 buildAttemptWhere() 產生,而它一律把
// c.var.email 綁在第一個參數上。request body 只說「要哪些條件」,從來不說
// 「是誰的」—— 和 routes/export.ts 同一個約定。
export const attemptLogRoutes = new Hono<AppContext>();

/** 逐列查詢。tags 與 confidence 都用相關子查詢,省掉第二輪 IN (...) 的分批。 */
const ROW_SQL = (where: string) => `
  SELECT a.created_at, a.chosen, a.is_correct, a.elapsed_ms, a.source,
         q.year, q.id AS question_id, q.stem, q.options_json, q.answer,
         (SELECT group_concat(t.tag, '|')
            FROM question_tags t WHERE t.question_id = a.question_id) AS tags,
         -- 信心是獨立事件流(confidence_events),沒有 attempt_id 可接。
         -- review.ts 的 /answer 用同一個 now 同時寫兩張表,所以
         -- (user, question, timestamp) 是精確對應而非近似比對。
         (SELECT ce.confidence FROM confidence_events ce
           WHERE ce.user_email = a.user_email
             AND ce.question_id = a.question_id
             AND ce.at = a.created_at
           LIMIT 1) AS confidence
    FROM attempts a
    JOIN questions q ON q.id = a.question_id
   WHERE ${where}
   ORDER BY a.created_at DESC
   LIMIT ?`;

type RawRow = {
	created_at: number;
	chosen: string;
	is_correct: number;
	elapsed_ms: number | null;
	source: string;
	year: number;
	question_id: string;
	stem: string;
	options_json: string;
	answer: string;
	tags: string | null;
	confidence: number | null;
};

function optionText(optionsJson: string, key: string): string {
	try {
		const opts = JSON.parse(optionsJson) as { key?: string; text?: string }[];
		if (!Array.isArray(opts)) return "";
		return opts.find((o) => o?.key === key)?.text ?? "";
	} catch {
		return "";
	}
}

function toLogRow(r: RawRow): AttemptLogRow {
	return {
		created_at: r.created_at,
		year: r.year,
		question_id: r.question_id,
		stem: r.stem,
		chosen: r.chosen,
		chosen_text: optionText(r.options_json, r.chosen),
		answer: r.answer,
		answer_text: optionText(r.options_json, r.answer),
		is_correct: r.is_correct,
		confidence: r.confidence,
		elapsed_ms: r.elapsed_ms,
		tags: r.tags ?? "",
		source: r.source,
	};
}

// 建 UI 用的骨架:只列出「這個人真的答過」的年份,選單才不會出現一個
// 按下去必然零筆的年份。
attemptLogRoutes.get("/meta", async (c) => {
	const email = c.var.email;
	const base = "a.user_email = ? AND a.chosen IS NOT NULL AND a.is_correct IS NOT NULL";
	const [years, span] = await c.env.DB.batch<any>([
		c.env.DB.prepare(
			`SELECT q.year AS year, COUNT(*) AS n
         FROM attempts a JOIN questions q ON q.id = a.question_id
        WHERE ${base}
        GROUP BY q.year ORDER BY q.year DESC`,
		).bind(email),
		c.env.DB.prepare(
			`SELECT COUNT(*) AS total, MIN(a.created_at) AS first_at, MAX(a.created_at) AS last_at
         FROM attempts a WHERE ${base}`,
		).bind(email),
	]);

	const s = (span.results?.[0] ?? {}) as {
		total?: number;
		first_at?: number | null;
		last_at?: number | null;
	};
	return c.json({
		years: (years.results ?? []) as { year: number; n: number }[],
		total: s.total ?? 0,
		first_at: s.first_at ?? null,
		last_at: s.last_at ?? null,
		max_rows: MAX_EXPORT_ROWS,
	});
});

// 下載前先報數,按鈕才寫得出「下載 CSV(1,234 筆)」而不是讓人下載完才發現是空的。
attemptLogRoutes.post("/preview", async (c) => {
	const filters = parseAttemptFilters(await c.req.json().catch(() => ({})));
	const { sql, params } = buildAttemptWhere(c.var.email, filters);
	const row = await c.env.DB.prepare(
		`SELECT COUNT(*) AS n
       FROM attempts a JOIN questions q ON q.id = a.question_id
      WHERE ${sql}`,
	)
		.bind(...params)
		.first<{ n: number }>();
	return c.json({ count: row?.n ?? 0 });
});

attemptLogRoutes.post("/export", async (c) => {
	const filters = parseAttemptFilters(await c.req.json().catch(() => ({})));
	const { sql, params } = buildAttemptWhere(c.var.email, filters);
	const res = await c.env.DB.prepare(ROW_SQL(sql))
		.bind(...params, MAX_EXPORT_ROWS)
		.all<RawRow>();

	const csv = renderAttemptCsv((res.results ?? []).map(toLogRow));
	return new Response(csv, {
		headers: {
			"Content-Type": "text/csv; charset=utf-8",
			"Content-Disposition": contentDisposition(exportFilename(filters, Date.now())),
			"Cache-Control": "no-store",
		},
	});
});

import { Hono } from "hono";
import type { D1PreparedStatement } from "@cloudflare/workers-types";
import type { AppContext, Question, Explanation } from "../types";
import { optionsToRecord } from "../lib/db";
import { ftsQuery } from "./search";
import { getActiveChallenge } from "../lib/challenges";
import { isAdminEmail } from "../lib/admin";

export const questionsRoutes = new Hono<AppContext>();

// ------------------------------------------------------------
// List / filter questions
// ------------------------------------------------------------
questionsRoutes.get("/", async (c) => {
	const year = c.req.query("year");
	const group = c.req.query("group"); // '內科' | '共同'
	const tags = c.req.query("tags"); // comma-separated, AND-semantics
	const q = c.req.query("q"); // free text in stem
	const limit = Math.min(parseInt(c.req.query("limit") || "50"), 200);
	const offset = parseInt(c.req.query("offset") || "0");

	const where: string[] = [];
	const params: any[] = [];

	if (year) {
		where.push("q.year = ?");
		params.push(parseInt(year));
	}
	if (group) {
		where.push('q."group" = ?');
		params.push(group);
	}
	if (q) {
		where.push("q.stem LIKE ?");
		params.push(`%${q}%`);
	}

	let joinSql = "";
	if (tags) {
		const tagList = tags
			.split(",")
			.map((t) => t.trim())
			.filter(Boolean);
		if (tagList.length > 0) {
			// q must have ALL tags
			joinSql = `
        JOIN (
          SELECT question_id
          FROM question_tags
          WHERE tag IN (${tagList.map(() => "?").join(",")})
          GROUP BY question_id
          HAVING COUNT(DISTINCT tag) = ?
        ) tf ON tf.question_id = q.id
      `;
			params.push(...tagList, tagList.length);
		}
	}

	const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
	const sql = `SELECT q.id, q.year, q.number, q.stem, q."group", q.difficulty
               FROM questions q
               ${joinSql}
               ${whereSql}
               ORDER BY q.year DESC, q.number ASC
               LIMIT ? OFFSET ?`;
	params.push(limit, offset);

	const { results } = await c.env.DB.prepare(sql)
		.bind(...params)
		.all();
	return c.json(results);
});

// ------------------------------------------------------------
// Get question with parsed options + explanation + tags + my_progress
// ------------------------------------------------------------
questionsRoutes.get("/:id", async (c) => {
	const id = c.req.param("id");
	const email = c.var.email;

	const question = await c.env.DB.prepare(
		"SELECT * FROM questions WHERE id = ?",
	)
		.bind(id)
		.first<Question>();

	if (!question) return c.json({ error: "not found" }, 404);

	const explanation = await c.env.DB.prepare(
		"SELECT * FROM explanations WHERE question_id = ?",
	)
		.bind(id)
		.first<Explanation>();

	const { results: tagRows } = await c.env.DB.prepare(
		"SELECT tag FROM question_tags WHERE question_id = ? ORDER BY created_at ASC",
	)
		.bind(id)
		.all<{ tag: string }>();

	const [progress, bookmark, note, backRefRows, activeChallenge] = await Promise.all([
		c.env.DB.prepare(
			"SELECT times_seen, times_correct, last_chosen, last_correct FROM review_progress WHERE user_email = ? AND question_id = ?",
		)
			.bind(email, id)
			.first<any>(),
		c.env.DB.prepare(
			"SELECT folder_id FROM bookmark_items WHERE user_email = ? AND question_id = ?",
		)
			.bind(email, id)
			.first<{ folder_id: string | null } | null>(),
		c.env.DB.prepare(
			"SELECT content_json, updated_at FROM personal_notes WHERE user_email = ? AND question_id = ?",
		)
			.bind(email, id)
			.first<{ content_json: string; updated_at: number } | null>(),
		c.env.DB.prepare(
			`SELECT r.source_type, r.source_id, r.by_email, r.created_at,
                q.year AS source_year, q.number AS source_number, q.stem AS source_stem
         FROM question_refs r
         JOIN questions q ON q.id = (CASE
           WHEN r.source_type = 'explanation' THEN r.source_id
           WHEN r.source_type = 'comment' THEN (SELECT question_id FROM comments WHERE id = r.source_id)
         END)
         WHERE r.target_question_id = ?
         ORDER BY r.created_at DESC
         LIMIT 50`,
		)
			.bind(id)
			.all<{
				source_type: "explanation" | "comment";
				source_id: string;
				by_email: string;
				created_at: number;
				source_year: number;
				source_number: number;
				source_stem: string;
			}>(),
		getActiveChallenge(c.env.DB, id, email),
	]);

	const my_progress =
		progress || bookmark
			? {
					times_seen: progress?.times_seen ?? 0,
					times_correct: progress?.times_correct ?? 0,
					last_chosen: progress?.last_chosen ?? null,
					last_correct: progress?.last_correct ?? null,
					bookmarked: bookmark ? 1 : 0,
					bookmark_folder_id: bookmark?.folder_id ?? null,
				}
			: null;

	const back_refs = (backRefRows.results ?? []).map((r) => ({
		source_type: r.source_type,
		source_question_id: `${r.source_year}-${String(r.source_number).padStart(3, "0")}`,
		source_stem: r.source_stem,
		by_email: r.by_email,
		created_at: r.created_at,
	}));

	return c.json({
		...question,
		options: optionsToRecord(question.options_json),
		tags: tagRows.map((t) => t.tag),
		explanation: explanation || null,
		my_progress,
		my_note: note || null,
		back_refs,
		active_challenge: activeChallenge,
		can_edit_answer: isAdminEmail(email, c.env),
	});
});

// ------------------------------------------------------------
// Admin-only canonical answer edit
// ------------------------------------------------------------
questionsRoutes.put("/:id/answer", async (c) => {
	const id = c.req.param("id");
	const email = c.var.email;

	if (!isAdminEmail(email, c.env)) {
		return c.json({ error: "forbidden" }, 403);
	}

	const body = await c.req.json<{ answer?: string }>();
	const nextAnswer = (body.answer || "").trim().toUpperCase();
	if (!/^[A-E]$/.test(nextAnswer)) {
		return c.json({ error: "answer must be A-E" }, 400);
	}

	const question = await c.env.DB.prepare(
		"SELECT id, answer, options_json FROM questions WHERE id = ?",
	)
		.bind(id)
		.first<{ id: string; answer: string; options_json: string }>();
	if (!question) return c.json({ error: "not found" }, 404);

	const options = optionsToRecord(question.options_json);
	if (!options[nextAnswer]) {
		return c.json({ error: "answer is not an option of this question" }, 400);
	}

	if (question.answer === nextAnswer) {
		return c.json({ ok: true, answer: nextAnswer, changed: false });
	}

	const now = Date.now();
	const hasHistory = await c.env.DB.prepare(
		"SELECT 1 FROM answer_history WHERE question_id = ? LIMIT 1",
	)
		.bind(id)
		.first<{ "1": number }>();

	const ops: D1PreparedStatement[] = [];
	if (!hasHistory) {
		ops.push(
			c.env.DB.prepare(
				`INSERT INTO answer_history
           (question_id, previous_answer, new_answer, source, challenge_id, changed_by, changed_at)
         VALUES (?, ?, ?, 'original', NULL, NULL, ?)`,
			).bind(id, question.answer, question.answer, now),
		);
	}

	ops.push(
		c.env.DB.prepare(
			`INSERT INTO answer_history
         (question_id, previous_answer, new_answer, source, challenge_id, changed_by, changed_at)
       VALUES (?, ?, ?, 'admin', NULL, ?, ?)`,
		).bind(id, question.answer, nextAnswer, email, now),
	);
	ops.push(
		c.env.DB.prepare("UPDATE questions SET answer = ? WHERE id = ?").bind(
			nextAnswer,
			id,
		),
	);
	ops.push(
		c.env.DB.prepare(
			`UPDATE answer_challenges
         SET status = 'archived', resolved_at = ?, resolution_reason = 'admin:answer-edit'
       WHERE question_id = ? AND status IN ('open', 'contested')`,
		).bind(now, id),
	);

	await c.env.DB.batch(ops);
	return c.json({ ok: true, answer: nextAnswer, changed: true });
});

// ------------------------------------------------------------
// Autocomplete lookup (for @YYY-NNN mention picker)
// ------------------------------------------------------------
questionsRoutes.get("/_meta/lookup", async (c) => {
	const q = (c.req.query("q") || "").trim();
	if (!q) return c.json([]);
	// Match leading digits / partial YYY-NNN
	const like = `${q.replace(/[%_]/g, "")}%`;
	const { results } = await c.env.DB.prepare(
		`SELECT id, year, number, stem
       FROM questions
       WHERE id LIKE ?
       ORDER BY year DESC, number ASC
       LIMIT 8`,
	)
		.bind(like)
		.all<{ id: string; year: number; number: number; stem: string }>();
	return c.json(results);
});

// ------------------------------------------------------------
// 相似題目 — tag overlap, with FTS5 BM25 fallback when sparse
// ------------------------------------------------------------
type SimilarRow = {
	id: string;
	year: number;
	number: number;
	stem: string;
	group: "內科" | "共同" | null;
	shared_tags: number;
	source: "tag" | "fts";
};

questionsRoutes.get("/:id/similar", async (c) => {
	const id = c.req.param("id");
	const limit = Math.min(parseInt(c.req.query("limit") || "5"), 10);

	const self = await c.env.DB.prepare(
		'SELECT id, "group", stem FROM questions WHERE id = ?',
	)
		.bind(id)
		.first<{ id: string; group: "內科" | "共同" | null; stem: string }>();
	if (!self) return c.json([]);

	// Step 1: tag overlap — same tag = related. Prefer same group, then
	// more recent year. Self is excluded.
	const { results: byTag } = await c.env.DB.prepare(
		`SELECT q.id, q.year, q.number, q.stem, q."group",
            COUNT(DISTINCT qt.tag) AS shared_tags,
            'tag' AS source
     FROM question_tags qt
     JOIN questions q ON q.id = qt.question_id
     WHERE qt.tag IN (SELECT tag FROM question_tags WHERE question_id = ?)
       AND q.id != ?
     GROUP BY q.id
     ORDER BY shared_tags DESC,
              (CASE WHEN q."group" = ? THEN 0 ELSE 1 END) ASC,
              q.year DESC, q.number ASC
     LIMIT ?`,
	)
		.bind(id, id, self.group ?? "", limit)
		.all<SimilarRow>();

	if (byTag.length >= limit) return c.json(byTag);

	// Step 2: BM25 fallback — fill from FTS5 matches on the source stem.
	// Cap the input so the FTS5 query stays small; reuse the same query
	// shaping the /api/search endpoint uses.
	const fillN = limit - byTag.length;
	const seenIds = [id, ...byTag.map((r) => r.id)];
	const ftsExpr = ftsQuery(self.stem.slice(0, 60));
	if (!ftsExpr) return c.json(byTag);

	const placeholders = seenIds.map(() => "?").join(",");
	try {
		const { results: byFts } = await c.env.DB.prepare(
			`SELECT q.id, q.year, q.number, q.stem, q."group",
              0 AS shared_tags, 'fts' AS source
       FROM questions q
       JOIN questions_fts f ON f.rowid = q.rowid
       WHERE questions_fts MATCH ?
         AND q.id NOT IN (${placeholders})
       ORDER BY bm25(questions_fts) ASC
       LIMIT ?`,
		)
			.bind(ftsExpr, ...seenIds, fillN)
			.all<SimilarRow>();
		return c.json([...byTag, ...byFts]);
	} catch {
		// Malformed FTS query (rare with our shaper) — return what we have.
		return c.json(byTag);
	}
});

// ------------------------------------------------------------
// Tags CRUD on a question
// ------------------------------------------------------------
questionsRoutes.post("/:id/tags", async (c) => {
	const id = c.req.param("id");
	const email = c.var.email;
	const body = await c.req.json<{ tag: string }>();
	const tag = (body.tag || "").trim();

	if (!tag) return c.json({ error: "empty tag" }, 400);
	if (tag.length > 40) return c.json({ error: "tag too long" }, 400);

	await c.env.DB.prepare(
		`INSERT INTO question_tags (question_id, tag, created_by, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(question_id, tag) DO NOTHING`,
	)
		.bind(id, tag, email, Date.now())
		.run();

	return c.json({ ok: true, tag });
});

questionsRoutes.delete("/:id/tags/:tag", async (c) => {
	const id = c.req.param("id");
	const tag = decodeURIComponent(c.req.param("tag"));

	await c.env.DB.prepare(
		"DELETE FROM question_tags WHERE question_id = ? AND tag = ?",
	)
		.bind(id, tag)
		.run();

	return c.json({ ok: true });
});

// ------------------------------------------------------------
// Aggregate (anonymous) review-mode stats for one question.
// Sums times_seen / times_correct across all users — no identity exposed.
// Cheap query; lazy-loaded by the UI when the answer is revealed.
// ------------------------------------------------------------
questionsRoutes.get("/:id/stats", async (c) => {
	const id = c.req.param("id");
	const row = await c.env.DB.prepare(
		`SELECT
       COALESCE(SUM(times_seen), 0)    AS attempts,
       COALESCE(SUM(times_correct), 0) AS correct,
       COUNT(*)                         AS responders
     FROM review_progress
     WHERE question_id = ? AND times_seen > 0`,
	)
		.bind(id)
		.first<{ attempts: number; correct: number; responders: number }>();

	const attempts = row?.attempts ?? 0;
	const correct = row?.correct ?? 0;
	const responders = row?.responders ?? 0;
	const accuracy = attempts > 0 ? Math.round((correct * 1000) / attempts) / 10 : null;

	return c.json({ attempts, correct, responders, accuracy });
});

// ------------------------------------------------------------
// Meta
// ------------------------------------------------------------

// Years (民國) with question counts
questionsRoutes.get("/_meta/years", async (c) => {
	const { results } = await c.env.DB.prepare(
		"SELECT year, COUNT(*) as count FROM questions GROUP BY year ORDER BY year DESC",
	).all();
	return c.json(results);
});

// Groups
questionsRoutes.get("/_meta/groups", async (c) => {
	const { results } = await c.env.DB.prepare(
		`SELECT "group", COUNT(*) as count
       FROM questions
       WHERE "group" IS NOT NULL
       GROUP BY "group"
       ORDER BY count DESC`,
	).all();
	return c.json(results);
});

// Tag cloud (most-used tags)
questionsRoutes.get("/_meta/tags", async (c) => {
	const { results } = await c.env.DB.prepare(
		`SELECT tag, COUNT(*) as count
       FROM question_tags
       GROUP BY tag
       ORDER BY count DESC, tag ASC
       LIMIT 200`,
	).all();
	return c.json(results);
});

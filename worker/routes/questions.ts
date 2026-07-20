import { Hono } from "hono";
import type { D1PreparedStatement } from "@cloudflare/workers-types";
import type { AppContext, Question, Explanation } from "../types";
import { optionsToRecord } from "../lib/db";
import { ftsQuery } from "./search";
import { getActiveChallenges } from "../lib/challenges";
import { isAdminEmail } from "../lib/admin";
import { mergeSimilar } from "../lib/similar";
import { explanationPlainText, dedupeTerms } from "../lib/cloze";
import { EMBED_MODEL, TEXT_MODEL } from "../lib/ai-models";

export const questionsRoutes = new Hono<AppContext>();

// ------------------------------------------------------------
// List / filter questions
// ------------------------------------------------------------
questionsRoutes.get("/", async (c) => {
	const email = c.var.email;
	const year = c.req.query("year");
	const group = c.req.query("group"); // one of the labels from config.toml [groups].list
	const tags = c.req.query("tags"); // comma-separated, AND-semantics
	const q = c.req.query("q"); // free text in stem
	const limit = Math.min(parseInt(c.req.query("limit") || "50"), 200);
	const offset = parseInt(c.req.query("offset") || "0");

	// Bind params are positional — keep these arrays in the same order the
	// placeholders appear in the SQL (tag join → progress join → where).
	const where: string[] = [];
	const whereParams: any[] = [];

	if (year) {
		where.push("q.year = ?");
		whereParams.push(parseInt(year));
	}
	if (group) {
		where.push('q."group" = ?');
		whereParams.push(group);
	}
	if (q) {
		where.push("q.stem LIKE ?");
		whereParams.push(`%${q}%`);
	}

	let joinSql = "";
	const joinParams: any[] = [];
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
			joinParams.push(...tagList, tagList.length);
		}
	}

	const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
	const sql = `SELECT q.id, q.year, q.number, q.stem, q."group", q.difficulty,
                      rp.times_seen, rp.last_correct
               FROM questions q
               ${joinSql}
               LEFT JOIN review_progress rp
                 ON rp.question_id = q.id AND rp.user_email = ?
               ${whereSql}
               ORDER BY q.year DESC, q.number ASC
               LIMIT ? OFFSET ?`;
	const params = [...joinParams, email, ...whereParams, limit, offset];

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

	const [progress, bookmark, note, backRefRows, activeChallenges, commentCountRow] = await Promise.all([
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
		getActiveChallenges(c.env.DB, id, email),
		// Comment count for the 討論串 tab badge — cheap COUNT(*), runs in parallel
		// with everything else so it adds no latency.
		c.env.DB.prepare(
			"SELECT COUNT(*) AS n FROM comments WHERE question_id = ?",
		)
			.bind(id)
			.first<{ n: number } | null>(),
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
		active_challenges: activeChallenges,
		comment_count: commentCountRow?.n ?? 0,
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
	group: string | null;
	shared_tags: number;
	source: "vec" | "tag" | "fts";
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

	// Source 1: Vectorize semantic neighbors — the "同機轉、不同 vignette"
	// matches that tag/BM25 miss. Best-effort: if embedding fails or the
	// index isn't populated yet, degrade to tag+FTS rather than 500.
	let vec: { id: string; score: number }[] = [];
	try {
		const emb = await c.env.AI.run(EMBED_MODEL, { text: [self.stem] });
		const vector = (emb as { data: number[][] }).data[0];
		const res = await c.env.VEC.query(vector, { topK: limit + 5 });
		vec = (res.matches ?? [])
			.filter((m) => m.id !== id)
			.map((m) => ({ id: m.id, score: m.score }));
	} catch {
		vec = [];
	}

	// Source 2: tag overlap — same tag = related. Prefer same group, then
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

	// Source 3: BM25 FTS fill — only when vec+tag can't reach the limit.
	// Reuse the same query shaping the /api/search endpoint uses.
	let byFts: SimilarRow[] = [];
	const prelim = new Set<string>([id, ...vec.map((v) => v.id), ...byTag.map((r) => r.id)]);
	if (prelim.size - 1 < limit) {
		const ftsExpr = ftsQuery(self.stem.slice(0, 60));
		if (ftsExpr) {
			const seenIds = [...prelim];
			const placeholders = seenIds.map(() => "?").join(",");
			try {
				const { results } = await c.env.DB.prepare(
					`SELECT q.id, q.year, q.number, q.stem, q."group",
              0 AS shared_tags, 'fts' AS source
       FROM questions q
       JOIN questions_fts f ON f.rowid = q.rowid
       WHERE questions_fts MATCH ?
         AND q.id NOT IN (${placeholders})
       ORDER BY bm25(questions_fts) ASC
       LIMIT ?`,
				)
					.bind(ftsExpr, ...seenIds, limit)
					.all<SimilarRow>();
				byFts = results;
			} catch {
				// Malformed FTS query (rare with our shaper) — skip this source.
				byFts = [];
			}
		}
	}

	// Rank + de-dupe across the three sources (vec first, by score).
	const merged = mergeSimilar({
		self: id,
		vec,
		tag: byTag.map((r) => ({ id: r.id })),
		fts: byFts.map((r) => ({ id: r.id })),
		limit,
	});
	if (merged.length === 0) return c.json([]);

	// Hydrate display fields. tag/fts rows are already loaded; vec-only ids
	// need one lookup. Output preserves the merged ranking + source.
	const rowById = new Map<string, SimilarRow>();
	for (const r of byTag) rowById.set(r.id, r);
	for (const r of byFts) if (!rowById.has(r.id)) rowById.set(r.id, r);
	const missing = merged.map((m) => m.id).filter((mid) => !rowById.has(mid));
	if (missing.length) {
		const ph = missing.map(() => "?").join(",");
		const { results } = await c.env.DB.prepare(
			`SELECT id, year, number, stem, "group", 0 AS shared_tags, 'tag' AS source
       FROM questions WHERE id IN (${ph})`,
		)
			.bind(...missing)
			.all<SimilarRow>();
		for (const r of results) rowById.set(r.id, r);
	}

	const out: SimilarRow[] = [];
	for (const m of merged) {
		const row = rowById.get(m.id);
		if (row) out.push({ ...row, source: m.source });
	}
	return c.json(out);
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

// ------------------------------------------------------------
// 自動 cloze — AI-extracted key terms, on-demand only (button press) to stay
// within the free Workers AI budget. No FSRS: this just feeds the 防劇透
// self-test.
//   ?source=explanation (default) — the shared 詳解, cached per version.
//   ?source=note                  — this user's 個人筆記. Not cached: a private
//                                   note has no version column and gets edited
//                                   far more often than it gets cloze'd.
// ------------------------------------------------------------
questionsRoutes.get("/:id/auto-cloze", async (c) => {
	const id = c.req.param("id");
	const source = c.req.query("source") === "note" ? "note" : "explanation";

	let contentJson: string;
	let expVersion = 0; // only meaningful (and only written back) for 詳解
	if (source === "note") {
		const note = await c.env.DB.prepare(
			"SELECT content_json FROM personal_notes WHERE user_email = ? AND question_id = ?",
		)
			.bind(c.var.email, id)
			.first<{ content_json: string }>();
		if (!note) return c.json({ terms: [], cached: false });
		contentJson = note.content_json;
	} else {
		const exp = await c.env.DB.prepare(
			"SELECT content_json, version FROM explanations WHERE question_id = ?",
		)
			.bind(id)
			.first<{ content_json: string; version: number }>();
		if (!exp) return c.json({ terms: [], cached: false });
		contentJson = exp.content_json;

		// Cache hit — same explanation version, reuse the extracted terms.
		const cached = await c.env.DB.prepare(
			"SELECT terms_json, version FROM explanation_cloze WHERE question_id = ?",
		)
			.bind(id)
			.first<{ terms_json: string; version: number }>();
		if (cached && cached.version === exp.version) {
			return c.json({ terms: safeParseTerms(cached.terms_json), cached: true });
		}
		expVersion = exp.version;
	}

	let doc: unknown;
	try {
		doc = JSON.parse(contentJson);
	} catch {
		return c.json({ terms: [], cached: false });
	}
	const text = explanationPlainText(doc);
	if (text.length < 40) return c.json({ terms: [], cached: false });

	// Extract verbatim key terms via the text model (structured output).
	let terms: string[] = [];
	try {
		const out = await c.env.AI.run(TEXT_MODEL, {
			max_tokens: 400,
			temperature: 0.1,
			response_format: {
				type: "json_schema",
				json_schema: {
					type: "object",
					properties: {
						terms: {
							type: "array",
							minItems: 3,
							maxItems: 8,
							items: { type: "string" },
						},
					},
					required: ["terms"],
					additionalProperties: false,
				},
			},
			messages: [
				{
					role: "system",
					content:
						`你是醫學考試出題助教。從${source === "note" ? "這份讀書筆記" : "詳解"}中挑出最值得考的 5–8 個關鍵詞(疾病名、藥名、機轉、數值、基因)。` +
						"必須是原文中一字不差出現的片段(供挖空自我測驗用),不要改寫、不要翻譯、不要加解釋。只輸出 JSON。",
				},
				{ role: "user", content: text.slice(0, 3000) },
			],
		});
		const raw = (out as { response?: unknown }).response ?? out;
		terms = dedupeTerms(extractTermsField(raw));
	} catch {
		terms = [];
	}

	if (terms.length === 0) return c.json({ terms: [], cached: false });

	if (source === "explanation") {
		await c.env.DB.prepare(
			`INSERT INTO explanation_cloze (question_id, version, terms_json, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(question_id) DO UPDATE SET
       version = excluded.version,
       terms_json = excluded.terms_json,
       created_at = excluded.created_at`,
		)
			.bind(id, expVersion, JSON.stringify(terms), Date.now())
			.run();
	}

	return c.json({ terms, cached: false });
});

function safeParseTerms(json: string): string[] {
	try {
		const arr = JSON.parse(json);
		return Array.isArray(arr) ? arr.filter((t) => typeof t === "string") : [];
	} catch {
		return [];
	}
}

// The model may return an object, a JSON string, or {terms:[...]}. Normalize
// to the raw terms array (dedupeTerms does the cleanup).
function extractTermsField(raw: unknown): unknown {
	let val = raw;
	if (typeof val === "string") {
		try {
			val = JSON.parse(val);
		} catch {
			return [];
		}
	}
	if (val && typeof val === "object" && "terms" in val) {
		return (val as { terms: unknown }).terms;
	}
	return val;
}

import { Hono } from "hono";
import type {
	D1Database,
	D1PreparedStatement,
} from "@cloudflare/workers-types";
import type { AppContext, Explanation, Question } from "../types";
import { optionsToRecord } from "../lib/db";
import {
	nextFsrsCard,
	previewFsrs,
	ratingFromInput,
	ratingName,
	retrievability,
	serializeCard,
	type FsrsCardRow,
} from "../lib/fsrs";

export const reviewRoutes = new Hono<AppContext>();

type DeckStats = {
	year: number;
	count: number;
	due_count: number;
	new_count: number;
	due_review_count: number;
	learning_count: number;
	review_count: number;
	studied_count: number;
	next_due_at: number | null;
};

type AnkiQuestionRow = Question & {
	explanation_content_json: string | null;
	explanation_version: number | null;
	explanation_updated_by: string | null;
	explanation_updated_at: number | null;
	fsrs_due_at: number | null;
	fsrs_stability: number | null;
	fsrs_difficulty: number | null;
	fsrs_elapsed_days: number | null;
	fsrs_scheduled_days: number | null;
	fsrs_learning_steps: number | null;
	fsrs_reps: number | null;
	fsrs_lapses: number | null;
	fsrs_state: number | null;
	fsrs_last_review_at: number | null;
};

function joinedFsrsRow(row: AnkiQuestionRow): FsrsCardRow | null {
	if (row.fsrs_due_at === null) return null;
	return {
		due_at: row.fsrs_due_at,
		stability: row.fsrs_stability ?? 0,
		difficulty: row.fsrs_difficulty ?? 0,
		elapsed_days: row.fsrs_elapsed_days ?? 0,
		scheduled_days: row.fsrs_scheduled_days ?? 0,
		learning_steps: row.fsrs_learning_steps ?? 0,
		reps: row.fsrs_reps ?? 0,
		lapses: row.fsrs_lapses ?? 0,
		state: row.fsrs_state ?? 0,
		last_review_at: row.fsrs_last_review_at,
	};
}

async function getDeckStats(
	db: D1Database,
	email: string,
	now: number,
	year?: number,
): Promise<DeckStats[]> {
	const where = year ? "WHERE q.year = ?" : "";
	const params: unknown[] = [email, now, now, now];
	if (year) params.push(year);
	const { results } = await db
		.prepare(
			`WITH mine AS (
         SELECT * FROM fsrs_cards WHERE user_email = ?
       )
       SELECT q.year,
              COUNT(*) AS count,
              SUM(CASE WHEN mine.question_id IS NULL OR mine.state = 0 THEN 1 ELSE 0 END) AS new_count,
              SUM(CASE WHEN mine.question_id IS NOT NULL AND mine.state <> 0 AND mine.due_at <= ? THEN 1 ELSE 0 END) AS due_review_count,
              SUM(CASE WHEN mine.question_id IS NULL OR mine.due_at <= ? THEN 1 ELSE 0 END) AS due_count,
              SUM(CASE WHEN mine.question_id IS NOT NULL AND mine.state IN (1, 3) THEN 1 ELSE 0 END) AS learning_count,
              SUM(CASE WHEN mine.question_id IS NOT NULL AND mine.state = 2 THEN 1 ELSE 0 END) AS review_count,
              SUM(CASE WHEN mine.question_id IS NOT NULL AND mine.reps > 0 THEN 1 ELSE 0 END) AS studied_count,
              MIN(CASE WHEN mine.question_id IS NOT NULL AND mine.due_at > ? THEN mine.due_at ELSE NULL END) AS next_due_at
       FROM questions q
       LEFT JOIN mine ON mine.question_id = q.id
       ${where}
       GROUP BY q.year
       ORDER BY q.year DESC`,
		)
		.bind(...params)
		.all<DeckStats>();
	return results;
}

function answerProgressOp(args: {
	email: string;
	questionId: string;
	chosen: string;
	isCorrect: 0 | 1;
	now: number;
	db: D1Database;
}): D1PreparedStatement {
	return args.db
		.prepare(
			`INSERT INTO review_progress
       (user_email, question_id, times_seen, times_correct, last_seen_at, last_chosen, last_correct)
       VALUES (?, ?, 1, ?, ?, ?, ?)
       ON CONFLICT(user_email, question_id) DO UPDATE SET
         times_seen = times_seen + 1,
         times_correct = times_correct + ?,
         last_seen_at = ?,
         last_chosen = ?,
         last_correct = ?`,
		)
		.bind(
			args.email,
			args.questionId,
			args.isCorrect,
			args.now,
			args.chosen,
			args.isCorrect,
			args.isCorrect,
			args.now,
			args.chosen,
			args.isCorrect,
		);
}

// Record an answer in review mode (also increments times_seen)
reviewRoutes.post("/answer", async (c) => {
	const email = c.var.email;
	const body = await c.req.json<{ question_id: string; chosen: string }>();
	const now = Date.now();

	// Check correctness
	const q = await c.env.DB.prepare("SELECT answer FROM questions WHERE id = ?")
		.bind(body.question_id)
		.first<{ answer: string }>();

	if (!q) return c.json({ error: "no such question" }, 404);
	const isCorrect = q.answer === body.chosen ? 1 : 0;

	await answerProgressOp({
		email,
		questionId: body.question_id,
		chosen: body.chosen,
		isCorrect,
		now,
		db: c.env.DB,
	}).run();

	return c.json({ correct: !!isCorrect, correct_answer: q.answer });
});

// Clear this user's review_progress for one question — used by the
// "清除本題作答紀錄" action in the reveal row. Idempotent.
reviewRoutes.delete("/answer/:id", async (c) => {
	const email = c.var.email;
	const id = c.req.param("id");
	await c.env.DB.prepare(
		"DELETE FROM review_progress WHERE user_email = ? AND question_id = ?",
	)
		.bind(email, id)
		.run();
	return c.json({ ok: true });
});

// Daily activity heatmap (for cal-heatmap). Counts answered questions
// (review-mode + exam-mode) per local-day for the last N days.
reviewRoutes.get("/heatmap", async (c) => {
	const email = c.var.email;
	const days = Math.min(parseInt(c.req.query("days") || "120"), 365);
	const since = Date.now() - days * 86_400_000;

	// Buckets: bind everything to the user's clock by computing day-strings
	// (YYYY-MM-DD) in UTC+8 (Asia/Taipei). D1 supports strftime modifier '+8 hours'.
	const { results } = await c.env.DB.prepare(
		`WITH a AS (
         SELECT last_seen_at AS ts FROM review_progress
           WHERE user_email = ? AND last_seen_at >= ?
         UNION ALL
         SELECT reviewed_at FROM fsrs_review_logs
           WHERE user_email = ? AND reviewed_at >= ?
         UNION ALL
         SELECT ea.answered_at FROM exam_answers ea
           JOIN exam_sessions es ON es.id = ea.session_id
           WHERE es.user_email = ? AND ea.answered_at >= ?
       )
       SELECT strftime('%Y-%m-%d', ts / 1000, 'unixepoch', '+8 hours') AS d,
              COUNT(*) AS n
       FROM a
       WHERE ts IS NOT NULL
       GROUP BY d
       ORDER BY d`,
	)
		.bind(email, since, email, since, email, since)
		.all<{ d: string; n: number }>();
	return c.json(results);
});

// FSRS/Anki deck stats. Each exam year is treated as a deck.
reviewRoutes.get("/anki/decks", async (c) => {
	const email = c.var.email;
	return c.json(await getDeckStats(c.env.DB, email, Date.now()));
});

// Next due/new Anki card for a year deck. Existing due cards come first,
// then unseen cards in question-number order.
reviewRoutes.get("/anki/decks/:year/next", async (c) => {
	const email = c.var.email;
	const year = parseInt(c.req.param("year"));
	if (!Number.isFinite(year)) return c.json({ error: "invalid year" }, 400);

	const now = Date.now();
	const row = await c.env.DB.prepare(
		`SELECT q.*,
              e.content_json AS explanation_content_json,
              e.version AS explanation_version,
              e.updated_by AS explanation_updated_by,
              e.updated_at AS explanation_updated_at,
              fc.due_at AS fsrs_due_at,
              fc.stability AS fsrs_stability,
              fc.difficulty AS fsrs_difficulty,
              fc.elapsed_days AS fsrs_elapsed_days,
              fc.scheduled_days AS fsrs_scheduled_days,
              fc.learning_steps AS fsrs_learning_steps,
              fc.reps AS fsrs_reps,
              fc.lapses AS fsrs_lapses,
              fc.state AS fsrs_state,
              fc.last_review_at AS fsrs_last_review_at
       FROM questions q
       LEFT JOIN explanations e ON e.question_id = q.id
       LEFT JOIN fsrs_cards fc ON fc.question_id = q.id AND fc.user_email = ?
       WHERE q.year = ?
         AND (fc.question_id IS NULL OR fc.due_at <= ?)
       ORDER BY
         CASE
           WHEN fc.question_id IS NOT NULL AND fc.state IN (1, 3) THEN 0
           WHEN fc.question_id IS NOT NULL THEN 1
           ELSE 2
         END,
         COALESCE(fc.due_at, ?),
         q.number ASC
       LIMIT 1`,
	)
		.bind(email, year, now, now)
		.first<AnkiQuestionRow>();

	const deck = (await getDeckStats(c.env.DB, email, now, year))[0] ?? null;
	if (!row) return c.json({ deck, question: null });

	const { results: tagRows } = await c.env.DB.prepare(
		"SELECT tag FROM question_tags WHERE question_id = ? ORDER BY created_at ASC",
	)
		.bind(row.id)
		.all<{ tag: string }>();

	const fsrsRow = joinedFsrsRow(row);
	const explanation: Partial<Explanation> | null = row.explanation_content_json
		? {
				question_id: row.id,
				content_json: row.explanation_content_json,
				version: row.explanation_version ?? 0,
				updated_by: row.explanation_updated_by,
				updated_at: row.explanation_updated_at ?? 0,
			}
		: null;

	return c.json({
		deck,
		question: {
			id: row.id,
			year: row.year,
			number: row.number,
			stem: row.stem,
			options: optionsToRecord(row.options_json),
			answer: row.answer,
			group: row.group,
			difficulty: row.difficulty,
			source: row.source,
			tags: tagRows.map((r) => r.tag),
			explanation,
			fsrs: {
				card: fsrsRow,
				preview: previewFsrs(fsrsRow, now),
				retrievability: retrievability(fsrsRow, now),
			},
		},
	});
});

// Grade the current Anki card with FSRS. `chosen` is optional: if present,
// it also records the MCQ answer in the existing review_progress table.
reviewRoutes.post("/anki/review", async (c) => {
	const email = c.var.email;
	const body = await c.req.json<{
		question_id?: string;
		rating?: string;
		chosen?: string | null;
	}>();
	const questionId = (body.question_id || "").trim();
	const rating = ratingFromInput(body.rating);
	if (!questionId || !rating) {
		return c.json({ error: "question_id and rating are required" }, 400);
	}

	const question = await c.env.DB.prepare(
		"SELECT id, answer, options_json FROM questions WHERE id = ?",
	)
		.bind(questionId)
		.first<Pick<Question, "id" | "answer" | "options_json">>();
	if (!question) return c.json({ error: "no such question" }, 404);

	const options = optionsToRecord(question.options_json);
	const chosen = body.chosen ? body.chosen.trim().toUpperCase() : null;
	if (chosen && (!/^[A-E]$/.test(chosen) || !options[chosen])) {
		return c.json(
			{ error: "chosen must be one of this question options" },
			400,
		);
	}

	const now = Date.now();
	const existing = await c.env.DB.prepare(
		`SELECT due_at, stability, difficulty, elapsed_days, scheduled_days,
              learning_steps, reps, lapses, state, last_review_at
       FROM fsrs_cards
       WHERE user_email = ? AND question_id = ?`,
	)
		.bind(email, questionId)
		.first<FsrsCardRow>();

	const result = nextFsrsCard(existing ?? null, now, rating);
	const card = serializeCard(result.card);
	const log = result.log;
	const ops: D1PreparedStatement[] = [
		c.env.DB.prepare(
			`INSERT INTO fsrs_cards
       (user_email, question_id, due_at, stability, difficulty, elapsed_days,
        scheduled_days, learning_steps, reps, lapses, state, last_review_at,
        created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_email, question_id) DO UPDATE SET
         due_at = excluded.due_at,
         stability = excluded.stability,
         difficulty = excluded.difficulty,
         elapsed_days = excluded.elapsed_days,
         scheduled_days = excluded.scheduled_days,
         learning_steps = excluded.learning_steps,
         reps = excluded.reps,
         lapses = excluded.lapses,
         state = excluded.state,
         last_review_at = excluded.last_review_at,
         updated_at = excluded.updated_at`,
		).bind(
			email,
			questionId,
			card.due_at,
			card.stability,
			card.difficulty,
			card.elapsed_days,
			card.scheduled_days,
			card.learning_steps,
			card.reps,
			card.lapses,
			card.state,
			card.last_review_at,
			now,
			now,
		),
		c.env.DB.prepare(
			`INSERT INTO fsrs_review_logs
       (user_email, question_id, rating, state, due_at, stability, difficulty,
        elapsed_days, last_elapsed_days, scheduled_days, learning_steps,
        reviewed_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).bind(
			email,
			questionId,
			log.rating,
			log.state,
			log.due.getTime(),
			log.stability,
			log.difficulty,
			log.elapsed_days,
			log.last_elapsed_days,
			log.scheduled_days,
			log.learning_steps,
			log.review.getTime(),
			now,
		),
	];

	let correct: boolean | null = null;
	if (chosen) {
		const isCorrect = question.answer === chosen ? 1 : 0;
		correct = !!isCorrect;
		ops.push(
			answerProgressOp({
				email,
				questionId,
				chosen,
				isCorrect,
				now,
				db: c.env.DB,
			}),
		);
	}

	await c.env.DB.batch(ops);
	return c.json({
		ok: true,
		rating: ratingName(rating),
		correct,
		correct_answer: question.answer,
		card,
		preview: previewFsrs(card, now),
	});
});

// My stats
reviewRoutes.get("/stats", async (c) => {
	const email = c.var.email;

	const totalSeen = await c.env.DB.prepare(
		"SELECT COUNT(*) as n FROM review_progress WHERE user_email = ? AND times_seen > 0",
	)
		.bind(email)
		.first<{ n: number }>();

	const totalCorrect = await c.env.DB.prepare(
		"SELECT SUM(times_correct) as c, SUM(times_seen) as t FROM review_progress WHERE user_email = ?",
	)
		.bind(email)
		.first<{ c: number; t: number }>();

	const byYear = await c.env.DB.prepare(
		`SELECT q.year, COUNT(*) as seen, SUM(rp.last_correct) as correct
       FROM review_progress rp
       JOIN questions q ON q.id = rp.question_id
       WHERE rp.user_email = ?
       GROUP BY q.year
       ORDER BY q.year DESC`,
	)
		.bind(email)
		.all();

	return c.json({
		questions_attempted: totalSeen?.n ?? 0,
		total_correct: totalCorrect?.c ?? 0,
		total_attempts: totalCorrect?.t ?? 0,
		by_year: byYear.results,
	});
});

// Wrong-answer list (review-mode mistakes), with year/tag/group filters
reviewRoutes.get("/wrong", async (c) => {
	const email = c.var.email;
	const year = c.req.query("year");
	const group = c.req.query("group");
	const tags = c.req.query("tags");

	const where: string[] = [
		"rp.user_email = ?",
		"rp.times_seen > 0",
		"(rp.times_correct * 100 / rp.times_seen) < 100",
	];
	const params: any[] = [email];

	if (year) {
		where.push("q.year = ?");
		params.push(parseInt(year));
	}
	if (group) {
		where.push('q."group" = ?');
		params.push(group);
	}

	let tagJoin = "";
	if (tags) {
		const list = tags
			.split(",")
			.map((t) => t.trim())
			.filter(Boolean);
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

	const sql = `
    SELECT q.id, q.year, q.number, q.stem, q."group",
           rp.times_seen, rp.times_correct
    FROM review_progress rp
    JOIN questions q ON q.id = rp.question_id
    ${tagJoin}
    WHERE ${where.join(" AND ")}
    ORDER BY (rp.times_correct * 100 / rp.times_seen) ASC, rp.last_seen_at DESC
    LIMIT 200
  `;
	const { results } = await c.env.DB.prepare(sql)
		.bind(...params)
		.all();
	return c.json(results);
});

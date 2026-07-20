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
import { calibration } from "../lib/calibration";
import { clusterByThreshold, type VecItem } from "../lib/cluster";
import { clampElapsedMs, insertAttemptOp } from "../lib/attempts";
import { dailyActivity, todayInTaipei } from "../lib/activity";
import { computePacing, suggestWeeklyTarget } from "../lib/goal-pacing";
import {
	clampHour,
	dayWindow,
	DEFAULT_DAY_START_HOUR,
} from "../lib/due-window";
import {
	parseNewLimit,
	pickNextKind,
	remainingNewToday,
} from "../lib/queue-mix";

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
	const body = await c.req.json<{
		question_id: string;
		chosen: string;
		confidence?: number;
		elapsed_ms?: number;
		source?: "review" | "drill";
	}>();
	const now = Date.now();

	// Check correctness
	const q = await c.env.DB.prepare("SELECT answer FROM questions WHERE id = ?")
		.bind(body.question_id)
		.first<{ answer: string }>();

	if (!q) return c.json({ error: "no such question" }, 404);
	const isCorrect = q.answer === body.chosen ? 1 : 0;

	// 聚合(derived cache)與事件(唯一真相)同進同退 — D1 batch 是單一交易。
	await c.env.DB.batch([
		answerProgressOp({
			email,
			questionId: body.question_id,
			chosen: body.chosen,
			isCorrect,
			now,
			db: c.env.DB,
		}),
		insertAttemptOp({
			db: c.env.DB,
			email,
			questionId: body.question_id,
			chosen: body.chosen,
			isCorrect,
			source: body.source === "drill" ? "drill" : "review",
			sessionId: null,
			elapsedMs: clampElapsedMs(body.elapsed_ms),
			now,
		}),
	]);

	// Pre-answer confidence (JOL) is optional — log it only when 1/2/3 so the
	// mock-exam flow (which never sends it) is unaffected.
	if (body.confidence === 1 || body.confidence === 2 || body.confidence === 3) {
		await c.env.DB.prepare(
			`INSERT INTO confidence_events (user_email, question_id, confidence, is_correct, at)
       VALUES (?, ?, ?, ?, ?)`,
		)
			.bind(email, body.question_id, body.confidence, isCorrect, now)
			.run();
	}

	return c.json({ correct: !!isCorrect, correct_answer: q.answer });
});

// Confidence calibration for the current user — per-bucket accuracy plus the
// most recent "高信心卻答錯" attempts (hypercorrection candidates).
reviewRoutes.get("/calibration", async (c) => {
	const email = c.var.email;

	const { results: events } = await c.env.DB.prepare(
		"SELECT confidence, is_correct FROM confidence_events WHERE user_email = ?",
	)
		.bind(email)
		.all<{ confidence: number; is_correct: number }>();

	const { results: highConfWrong } = await c.env.DB.prepare(
		`SELECT ce.question_id, q.year, q.number, q.stem, ce.at
     FROM confidence_events ce
     JOIN questions q ON q.id = ce.question_id
     WHERE ce.user_email = ? AND ce.confidence = 3 AND ce.is_correct = 0
     ORDER BY ce.at DESC
     LIMIT 20`,
	)
		.bind(email)
		.all<{
			question_id: string;
			year: number;
			number: number;
			stem: string;
			at: number;
		}>();

	return c.json({ buckets: calibration(events), high_conf_wrong: highConfWrong });
});

// Weakness concept map — cluster the user's wrong questions by semantic
// similarity (via the same VEC index as 相似題) into themes, each labelled by
// its most common tag and linkable to an interleaved drill. Diagnostic, not a
// learning method (retrieval practice > concept mapping — Karpicke & Blunt).
// Degrades to an empty map when the index isn't populated.
reviewRoutes.get("/weakness-map", async (c) => {
	const email = c.var.email;

	const { results: wrong } = await c.env.DB.prepare(
		`SELECT question_id FROM review_progress
     WHERE user_email = ?
       AND times_seen > 0
       AND (last_correct = 0 OR times_correct * 2 < times_seen)
     ORDER BY last_seen_at DESC
     LIMIT 60`,
	)
		.bind(email)
		.all<{ question_id: string }>();
	const ids = wrong.map((r) => r.question_id);
	if (ids.length < 2) return c.json({ clusters: [], wrong_count: ids.length });

	// Fetch vectors for those questions. Best-effort — no index → empty map.
	let items: VecItem[] = [];
	try {
		const vecs = await c.env.VEC.getByIds(ids);
		items = (vecs ?? [])
			// values may be a plain array OR a Float32/Float64Array — accept both.
			.filter((v) => Array.isArray(v.values) || ArrayBuffer.isView(v.values))
			.map((v) => ({
				id: v.id,
				vector: Array.from(v.values as ArrayLike<number>),
			}));
	} catch {
		items = [];
	}
	if (items.length < 2) return c.json({ clusters: [], wrong_count: ids.length });

	const raw = clusterByThreshold(items, { threshold: 0.55 });

	// Label each cluster with its most common tag; attach a drill anchor +
	// year/number for display. One query covers tags for all members.
	const memberIds = raw.flatMap((cl) => cl.members);
	const ph = memberIds.map(() => "?").join(",");
	const { results: tagRows } = await c.env.DB.prepare(
		`SELECT question_id, tag FROM question_tags WHERE question_id IN (${ph})`,
	)
		.bind(...memberIds)
		.all<{ question_id: string; tag: string }>();
	const tagsByQ = new Map<string, string[]>();
	for (const r of tagRows) {
		const arr = tagsByQ.get(r.question_id);
		if (arr) arr.push(r.tag);
		else tagsByQ.set(r.question_id, [r.tag]);
	}

	const clusters = raw
		.filter((cl) => cl.members.length >= 2)
		.map((cl) => ({
			label: topTag(cl.members, tagsByQ) ?? "未分類",
			size: cl.members.length,
			anchor: cl.members[0],
			question_ids: cl.members,
		}));

	return c.json({ clusters, wrong_count: ids.length });
});

function topTag(members: string[], tagsByQ: Map<string, string[]>): string | null {
	const count = new Map<string, number>();
	for (const id of members) {
		for (const tag of tagsByQ.get(id) ?? []) {
			count.set(tag, (count.get(tag) ?? 0) + 1);
		}
	}
	let best: string | null = null;
	let bestN = 0;
	for (const [tag, n] of count) {
		if (n > bestN) {
			bestN = n;
			best = tag;
		}
	}
	return best;
}

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

	// Buckets: day-strings (YYYY-MM-DD) in UTC+8 (Asia/Taipei). The query
	// (and the reasoning behind which tables it reads) lives in
	// worker/lib/activity.ts — shared with the readiness card so the heatmap
	// squares and the card's daily rate can never disagree.
	// Response shape is unchanged: [{ d, n }, ...] ordered by day.
	return c.json(await dailyActivity(c.env.DB, email, since));
});

// Daily accuracy + average per-question time from the attempts log —
// the data basis for a learning curve. Bucketed by UTC+8 day, same as
// /heatmap. avg_ms is null for days with no timed answers (old clients,
// or answers that arrived without elapsed_ms).
reviewRoutes.get("/pacing", async (c) => {
	const email = c.var.email;
	const days = Math.min(parseInt(c.req.query("days") || "90"), 365);
	const since = Date.now() - days * 86_400_000;

	const { results } = await c.env.DB.prepare(
		`SELECT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch', '+8 hours') AS d,
            COUNT(*) AS n,
            SUM(CASE WHEN is_correct = 1 THEN 1 ELSE 0 END) AS correct,
            AVG(CASE WHEN elapsed_ms BETWEEN 1 AND 600000 THEN elapsed_ms END) AS avg_ms
     FROM attempts
     WHERE user_email = ? AND created_at >= ?
     GROUP BY d ORDER BY d`,
	)
		.bind(email, since)
		.all<{ d: string; n: number; correct: number; avg_ms: number | null }>();

	return c.json(results);
});

// FSRS/Anki deck stats. Each exam year is treated as a deck.
reviewRoutes.get("/anki/decks", async (c) => {
	const email = c.var.email;
	return c.json(await getDeckStats(c.env.DB, email, Date.now()));
});

type DueSummary = {
	learning: number;
	due_review: number;
	new_available: number;
	new_remaining: number;
	new_introduced_today: number;
	new_limit: number;
	due_total: number;
	next_due_at: number | null;
	by_year: { year: number; due: number }[];
	day_start_hour: number;
	day_start: number;
	day_end: number;
};

// 跨年份的「今天該複習什麼」摘要。與 getDeckStats 的差別:這裡套用日界
// (預設凌晨 4 點)與每日新卡上限,review 卡用日級判定、learning 卡用分鐘級。
async function getDueSummary(
	db: D1Database,
	email: string,
	now: number,
	opts: { dayStartHour: number; newLimit: number },
): Promise<DueSummary> {
	const w = dayWindow(now, { dayStartHour: opts.dayStartHour });

	const agg = await db
		.prepare(
			`WITH mine AS (SELECT * FROM fsrs_cards WHERE user_email = ?)
       SELECT
         SUM(CASE WHEN mine.state IN (1,3) AND mine.due_at <= ? THEN 1 ELSE 0 END) AS learning,
         SUM(CASE WHEN mine.state = 2 AND mine.due_at <= ? THEN 1 ELSE 0 END) AS due_review,
         SUM(CASE WHEN mine.question_id IS NULL OR mine.state = 0 THEN 1 ELSE 0 END) AS new_available,
         MIN(CASE WHEN mine.question_id IS NOT NULL
                   AND NOT ((mine.state IN (1,3) AND mine.due_at <= ?)
                         OR (mine.state = 2 AND mine.due_at <= ?))
                  THEN mine.due_at END) AS next_due_at
       FROM questions q
       LEFT JOIN mine ON mine.question_id = q.id`,
		)
		.bind(email, now, w.dayEnd, now, w.dayEnd)
		.first<Record<string, number | null>>();

	// fsrs_review_logs.state 是「複習前」的狀態(ts-fsrs RecordLogItem.log.state),
	// 所以 state = 0 的 log 就是該卡首次亮相 = 今天引入的新卡。
	const intro = await db
		.prepare(
			`SELECT COUNT(*) AS n FROM fsrs_review_logs
       WHERE user_email = ? AND reviewed_at >= ? AND reviewed_at < ? AND state = 0`,
		)
		.bind(email, w.dayStart, w.dayEnd)
		.first<{ n: number }>();

	const { results: by_year } = await db
		.prepare(
			`WITH mine AS (SELECT * FROM fsrs_cards WHERE user_email = ?)
       SELECT q.year AS year, COUNT(*) AS due
       FROM questions q JOIN mine ON mine.question_id = q.id
       WHERE (mine.state IN (1,3) AND mine.due_at <= ?)
          OR (mine.state = 2 AND mine.due_at <= ?)
       GROUP BY q.year ORDER BY q.year DESC`,
		)
		.bind(email, now, w.dayEnd)
		.all<{ year: number; due: number }>();

	const learning = agg?.learning ?? 0;
	const due_review = agg?.due_review ?? 0;
	const new_available = agg?.new_available ?? 0;
	const new_introduced_today = intro?.n ?? 0;
	const new_remaining = Math.min(
		new_available,
		remainingNewToday(new_introduced_today, opts.newLimit),
	);

	return {
		learning,
		due_review,
		new_available,
		new_remaining,
		new_introduced_today,
		new_limit: opts.newLimit,
		due_total: learning + due_review + new_remaining,
		next_due_at: agg?.next_due_at ?? null,
		by_year,
		day_start_hour: opts.dayStartHour,
		day_start: w.dayStart,
		day_end: w.dayEnd,
	};
}

function dueQueryOpts(c: {
	req: { query: (k: string) => string | undefined };
}): { dayStartHour: number; newLimit: number } {
	const raw = c.req.query("day_start");
	return {
		dayStartHour: clampHour(
			raw === undefined ? DEFAULT_DAY_START_HOUR : Number(raw),
		),
		newLimit: parseNewLimit(c.req.query("new_limit")),
	};
}

// 跨年份「今天該複習」摘要。逐年統計仍走 GET /anki/decks。
reviewRoutes.get("/due", async (c) => {
	return c.json(
		await getDueSummary(c.env.DB, c.var.email, Date.now(), dueQueryOpts(c)),
	);
});

// Next due/new Anki card for a year deck. Existing due cards come first,
// then unseen cards in question-number order.
reviewRoutes.get("/anki/decks/:year/next", async (c) => {
	const email = c.var.email;
	const year = parseInt(c.req.param("year"));
	if (!Number.isFinite(year)) return c.json({ error: "invalid year" }, 400);

	const now = Date.now();

	// Same daily new-card cap the cross-year /due queue enforces. Without it a
	// year deck will happily introduce all 100 unseen questions in one sitting,
	// and FSRS then schedules the whole batch to come due together a few days
	// later — the classic Anki new-card avalanche. Once the day's allowance is
	// spent this deck serves review cards only; `new_remaining` tells the UI so
	// it can say "今天的新卡上限到了" instead of looking empty.
	const { dayStartHour, newLimit } = dueQueryOpts(c);
	const w = dayWindow(now, { dayStartHour });
	const intro = await c.env.DB.prepare(
		`SELECT COUNT(*) AS n FROM fsrs_review_logs
     WHERE user_email = ? AND reviewed_at >= ? AND reviewed_at < ? AND state = 0`,
	)
		.bind(email, w.dayStart, w.dayEnd)
		.first<{ n: number }>();
	const newRemaining = remainingNewToday(intro?.n ?? 0, newLimit);

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
         AND (
           (fc.question_id IS NOT NULL AND fc.due_at <= ?)
           OR (? > 0 AND (fc.question_id IS NULL OR fc.state = 0))
         )
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
		.bind(email, year, now, newRemaining, now)
		.first<AnkiQuestionRow>();

	const deck = (await getDeckStats(c.env.DB, email, now, year))[0] ?? null;
	// So the client can distinguish "this year is finished" from "you have hit
	// today's new-card allowance" — both otherwise look like question: null.
	const newBudget = { new_remaining: newRemaining, new_limit: newLimit };
	if (!row) return c.json({ deck, question: null, ...newBudget });

	const { results: tagRows } = await c.env.DB.prepare(
		"SELECT tag FROM question_tags WHERE question_id = ? ORDER BY created_at ASC",
	)
		.bind(row.id)
		.all<{ tag: string }>();

	return c.json({
		deck,
		question: ankiQuestionPayload(row, tagRows, now),
		...newBudget,
	});
});

// 卡片 payload 組裝 — /anki/decks/:year/next 與 /due/next 共用,結構必須一致。
function ankiQuestionPayload(
	row: AnkiQuestionRow,
	tagRows: { tag: string }[],
	now: number,
) {
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

	return {
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
	};
}

// 跨年份到期佇列的下一張。與 /anki/decks/:year/next 並存:那支是「我要刷某
// 一年」(限定年份、無新卡上限),這支是「今天該做什麼」(全年份、按 due
// 排序、套每日新卡上限與交錯)。評分仍走 POST /anki/review,attempts 的寫入
// 路徑一行都不變。
reviewRoutes.get("/due/next", async (c) => {
	const email = c.var.email;
	const now = Date.now();
	const opts = dueQueryOpts(c);
	const served = Math.max(0, Number(c.req.query("served") ?? 0) || 0);

	const queue = await getDueSummary(c.env.DB, email, now, opts);
	const kind = pickNextKind({
		served,
		learning: queue.learning,
		dueReview: queue.due_review,
		newAvailable: queue.new_available,
		newRemaining: queue.new_remaining,
	});
	if (!kind) return c.json({ queue, kind: null, question: null });

	const filter =
		kind === "learning"
			? "fc.state IN (1,3) AND fc.due_at <= ?"
			: kind === "due"
				? "fc.state = 2 AND fc.due_at <= ?"
				: "(fc.question_id IS NULL OR fc.state = 0)";
	const order =
		kind === "new"
			? "q.year DESC, q.number ASC"
			: "fc.due_at ASC, q.year DESC, q.number ASC";
	const bind =
		kind === "new"
			? [email]
			: [email, kind === "learning" ? now : queue.day_end];

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
     WHERE ${filter}
     ORDER BY ${order}
     LIMIT 1`,
	)
		.bind(...bind)
		.first<AnkiQuestionRow>();
	if (!row) return c.json({ queue, kind: null, question: null });

	const { results: tagRows } = await c.env.DB.prepare(
		"SELECT tag FROM question_tags WHERE question_id = ? ORDER BY created_at ASC",
	)
		.bind(row.id)
		.all<{ tag: string }>();

	return c.json({ queue, kind, question: ankiQuestionPayload(row, tagRows, now) });
});

// Grade the current Anki card with FSRS. `chosen` is optional: if present,
// it also records the MCQ answer in the existing review_progress table.
reviewRoutes.post("/anki/review", async (c) => {
	const email = c.var.email;
	const body = await c.req.json<{
		question_id?: string;
		rating?: string;
		chosen?: string | null;
		elapsed_ms?: number;
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
		// 只有帶 chosen 的 rating 才算一次 MCQ 作答;純 rating 不進 attempts。
		ops.push(
			insertAttemptOp({
				db: c.env.DB,
				email,
				questionId,
				chosen,
				isCorrect,
				source: "anki",
				sessionId: null,
				elapsedMs: clampElapsedMs(body.elapsed_ms),
				now,
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

// 讀書進度預估 — 「以我目前的速度,考前做得完嗎」。
//
// 路徑叫 /readiness 而不是計畫寫的 /pacing:`GET /api/review/pacing` 已經
// 被每日正確率 + 每題平均秒數佔用(見上面),同名會直接吃掉既有端點。
//
// 全部 per-user(`c.var.email`),不接受 email 參數,也不回任何跨使用者
// 的比較數字 —— 沒有排行榜、沒有積分、沒有連續天數。
reviewRoutes.get("/readiness", async (c) => {
	const email = c.var.email;
	const now = Date.now();

	const [total, done, goal] = await Promise.all([
		c.env.DB.prepare("SELECT COUNT(*) AS n FROM questions").first<{
			n: number;
		}>(),
		// 與 GET /stats 的 questions_attempted 同一個定義,兩張卡才不打架。
		// 刻意不改用 COUNT(DISTINCT question_id) FROM attempts:attempts 自
		// 0023 起才有,歷史未回填,改用它會讓老使用者的「已完成」憑空縮水。
		c.env.DB.prepare(
			"SELECT COUNT(*) AS n FROM review_progress WHERE user_email = ? AND times_seen > 0",
		)
			.bind(email)
			.first<{ n: number }>(),
		c.env.DB.prepare(
			"SELECT weekly_target FROM study_goals WHERE user_email = ?",
		)
			.bind(email)
			.first<{ weekly_target: number }>(),
	]);

	// 28 天視窗:近 7 天算速度,其餘留給前端畫趨勢(目前未用)。
	const daily = await dailyActivity(c.env.DB, email, now - 28 * 86_400_000);

	// 考試日:worker 讀不到 config.toml,值由 setup.sh 鏡射進 [vars]。
	// 未設 / 設錯格式一律當作「沒有考試日」,不炸。
	const examMs = c.env.EXAM_DATE_ISO ? Date.parse(c.env.EXAM_DATE_ISO) : NaN;
	const daysLeft = Number.isFinite(examMs)
		? Math.ceil((examMs - now) / 86_400_000)
		: null;

	const totalQ = total?.n ?? 0;
	const completed = done?.n ?? 0;
	const weeklyTarget =
		goal?.weekly_target ??
		suggestWeeklyTarget(Math.max(totalQ - completed, 0), daysLeft);

	return c.json({
		...computePacing({
			daily,
			today: todayInTaipei(now),
			totalQuestions: totalQ,
			completed,
			daysLeft,
			weeklyTarget,
		}),
		weekly_target: weeklyTarget,
		weekly_target_is_default: !goal,
	});
});

// 設定每週目標。只有這一個數字被持久化 —— 進度本身永遠即時算。
reviewRoutes.put("/goal", async (c) => {
	const email = c.var.email;
	const body = await c.req
		.json<{ weekly_target?: number }>()
		.catch(() => ({}) as { weekly_target?: number });
	const t = Math.trunc(Number(body.weekly_target));
	if (!Number.isFinite(t) || t < 1 || t > 1000) {
		return c.json({ error: "weekly_target must be 1..1000" }, 400);
	}
	await c.env.DB.prepare(
		`INSERT INTO study_goals (user_email, weekly_target, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(user_email) DO UPDATE SET weekly_target = excluded.weekly_target,
                                           updated_at = excluded.updated_at`,
	)
		.bind(email, t, Date.now())
		.run();
	return c.json({ ok: true, weekly_target: t });
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

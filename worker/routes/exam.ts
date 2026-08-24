import { Hono } from "hono";
import type { D1PreparedStatement } from "@cloudflare/workers-types";
import type { AppContext, Env, ExamSession, Question } from "../types";
import { uuid, optionsToRecord } from "../lib/db";
import { clampElapsedMs, insertAttemptOp } from "../lib/attempts";
import { planAnswerWrites } from "../lib/exam-answers";
import {
	planApplyToReview,
	type ExamAnswerRow,
} from "../lib/apply-exam-to-review";
import { readIdemKey, idemLookup, idemRecordOp } from "../lib/idempotency";
import { median, pacingSplit } from "../lib/pacing";
import {
	buildTestFilter,
	normalizeFilters,
	type RawTestFilters,
} from "../lib/testBuilder";

export const examRoutes = new Hono<AppContext>();

// Real exam pacing: 1 minute per question. Total cap derives from the
// group composition declared in config.toml [groups].list — see the
// GROUPS env var. e.g. "內科:70,共同:30" → 100 min cap when both selected.
const MS_PER_QUESTION = 60 * 1000;

// Cached per request — parsed lazily so a hot reload of GROUPS picks up.
function parseGroupsConfig(
	raw: string | undefined,
): Array<{ label: string; count: number }> {
	if (!raw) return [];
	return raw
		.split(",")
		.map((part) => part.trim())
		.filter(Boolean)
		.map((part) => {
			const sep = part.lastIndexOf(":");
			if (sep < 0) return { label: part, count: 0 };
			return {
				label: part.slice(0, sep).trim(),
				count: Number(part.slice(sep + 1).trim()) || 0,
			};
		});
}

function validGroupLabels(env: Env): string[] {
	// No fallback — if GROUPS is unset, the worker returns 400 from /start so
	// the operator gets a clear signal that wrangler.toml needs the var.
	return parseGroupsConfig(env.GROUPS).map((g) => g.label);
}

// Start a new exam session. `groups` defaults to the full configured set
// for backwards compatibility with older clients that don't send it.
examRoutes.post("/start", async (c) => {
	const email = c.var.email;

	// 冪等:重送同一 key 直接 replay,不重複建立 session + N 列 answers。
	const idemKey = readIdemKey(c);
	if (idemKey) {
		const hit = await idemLookup(c.env.DB, email, idemKey);
		if (hit) return c.json(hit.body as any, hit.status as any);
	}

	const body = await c.req.json<{
		year: number;
		mode?: "full" | "partial";
		groups?: string[];
	}>();

	const validGroups = validGroupLabels(c.env);
	const groups: string[] =
		Array.isArray(body.groups) && body.groups.length > 0
			? body.groups.filter((g) => validGroups.includes(g))
			: [...validGroups];
	if (groups.length === 0) {
		return c.json({ error: "invalid groups" }, 400);
	}
	const placeholders = groups.map(() => "?").join(",");

	const { results: questions } = await c.env.DB.prepare(
		`SELECT id, year, number, stem, options_json
       FROM questions WHERE year = ? AND "group" IN (${placeholders})
       ORDER BY number ASC`,
	)
		.bind(body.year, ...groups)
		.all<Pick<Question, "id" | "year" | "number" | "stem" | "options_json">>();

	if (questions.length === 0) {
		return c.json({ error: "no questions for that selection" }, 404);
	}

	const sessionId = uuid();
	const now = Date.now();
	const capMs = questions.length * MS_PER_QUESTION;

	// Create session (immediately running) + empty answer rows in one batch
	const ops = [
		c.env.DB.prepare(
			`INSERT INTO exam_sessions (id, user_email, year, started_at, mode, elapsed_ms, running_since, cap_ms)
         VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
		).bind(sessionId, email, body.year, now, body.mode || "full", now, capMs),
	];
	for (const q of questions) {
		ops.push(
			c.env.DB.prepare(
				`INSERT INTO exam_answers (session_id, question_id) VALUES (?, ?)`,
			).bind(sessionId, q.id),
		);
	}

	const payload = {
		session_id: sessionId,
		started_at: now,
		elapsed_ms: 0,
		running_since: now,
		cap_ms: capMs,
		questions: questions.map((q) => ({
			id: q.id,
			number: q.number,
			stem: q.stem,
			options: optionsToRecord(q.options_json),
		})),
	};
	if (idemKey) {
		ops.push(
			idemRecordOp(c.env.DB, {
				email,
				key: idemKey,
				endpoint: "POST /exam/start",
				status: 200,
				body: payload,
				now,
			}),
		);
	}
	await c.env.DB.batch(ops);

	return c.json(payload);
});

// ---------------------------------------------------------------------------
// 自訂測驗(custom test builder)
//
// 產生的 session 與 /start 完全同構:一列 exam_sessions + N 列 exam_answers,
// 下游的 /state /answer /pause /resume /finish /:sid 一行都不用改(除了排序
// 改吃 ea.seq)。差別只在 exam_sessions.kind='custom'、year=0 哨兵,以及
// tutor/timed/filter_json 三個旗標。
//
// 這兩個 handler 必須註冊在 /:sid/* 之前 —— Hono 依註冊順序比對,
// POST /custom/preview 與 POST /:sid/pause 同為兩段路徑。
// ---------------------------------------------------------------------------

// 不計時:cap 大到不會觸發自動交卷(前端改為往上計時的碼表)。
const UNTIMED_CAP_MS = 24 * 60 * 60 * 1000;

// 預覽符合題數 — UI 每次改條件就打一次,只做一個 COUNT(*),不建 session。
examRoutes.post("/custom/preview", async (c) => {
	const email = c.var.email;
	const f = normalizeFilters(
		await c.req.json<RawTestFilters>().catch(() => ({})),
	);
	const { joinSql, whereSql, params } = buildTestFilter(f, email);

	const row = await c.env.DB.prepare(
		`SELECT COUNT(*) AS n FROM questions q ${joinSql} ${whereSql}`,
	)
		.bind(...params)
		.first<{ n: number }>();

	const available = row?.n ?? 0;
	return c.json({
		available,
		requested: f.count,
		will_use: Math.min(available, f.count),
	});
});

// 依篩選條件抽題並建立一場自訂測驗。回傳體與 /start 同形(多帶 kind/tutor/
// timed/year 與 requested/actual),前端可共用型別。
examRoutes.post("/custom", async (c) => {
	const email = c.var.email;

	// 冪等:重送同一 key 直接 replay,不重複建立自訂測驗 session。
	const idemKey = readIdemKey(c);
	if (idemKey) {
		const hit = await idemLookup(c.env.DB, email, idemKey);
		if (hit) return c.json(hit.body as any, hit.status as any);
	}

	const f = normalizeFilters(
		await c.req.json<RawTestFilters>().catch(() => ({})),
	);
	const { joinSql, whereSql, params } = buildTestFilter(f, email);

	// 隨機抽題:D1 的 RANDOM() 對 1000 列題庫成本可忽略。
	const { results: questions } = await c.env.DB.prepare(
		`SELECT q.id, q.year, q.number, q.stem, q.options_json
       FROM questions q ${joinSql} ${whereSql}
       ORDER BY RANDOM() LIMIT ?`,
	)
		.bind(...params, f.count)
		.all<Pick<Question, "id" | "year" | "number" | "stem" | "options_json">>();

	if (questions.length === 0) {
		return c.json({ error: "no questions match", available: 0 }, 404);
	}

	const sessionId = uuid();
	const now = Date.now();
	// 題數不足時不報錯 —— 直接用實際可用題數出卷,回傳體帶 requested/actual
	// 讓 UI 講清楚(不靜默截斷)。
	const capMs = f.timed ? questions.length * MS_PER_QUESTION : UNTIMED_CAP_MS;

	const ops = [
		c.env.DB.prepare(
			`INSERT INTO exam_sessions
           (id, user_email, year, started_at, mode, elapsed_ms, running_since, cap_ms,
            kind, tutor, timed, filter_json)
         VALUES (?, ?, 0, ?, 'partial', 0, ?, ?, 'custom', ?, ?, ?)`,
		).bind(
			sessionId,
			email,
			now,
			now,
			capMs,
			f.tutor ? 1 : 0,
			f.timed ? 1 : 0,
			JSON.stringify(f),
		),
	];
	questions.forEach((q, i) => {
		ops.push(
			c.env.DB.prepare(
				`INSERT INTO exam_answers (session_id, question_id, seq) VALUES (?, ?, ?)`,
			).bind(sessionId, q.id, i),
		);
	});

	const payload = {
		session_id: sessionId,
		started_at: now,
		elapsed_ms: 0,
		running_since: now,
		cap_ms: capMs,
		kind: "custom" as const,
		tutor: (f.tutor ? 1 : 0) as 0 | 1,
		timed: (f.timed ? 1 : 0) as 0 | 1,
		requested: f.count,
		actual: questions.length,
		questions: questions.map((q) => ({
			id: q.id,
			year: q.year,
			number: q.number,
			stem: q.stem,
			options: optionsToRecord(q.options_json),
		})),
	};
	if (idemKey) {
		ops.push(
			idemRecordOp(c.env.DB, {
				email,
				key: idemKey,
				endpoint: "POST /exam/custom",
				status: 200,
				body: payload,
				now,
			}),
		);
	}
	await c.env.DB.batch(ops);

	return c.json(payload);
});

// Resume / fetch an in-progress session (with all questions + saved answers).
// Used when the user navigates back to /exam/:sid after leaving.
examRoutes.get("/:sid/state", async (c) => {
	const sid = c.req.param("sid");
	const email = c.var.email;
	const now = Date.now();

	const session = await c.env.DB.prepare(
		"SELECT * FROM exam_sessions WHERE id = ?",
	)
		.bind(sid)
		.first<
			ExamSession & {
				elapsed_ms: number;
				running_since: number | null;
				cap_ms: number;
			}
		>();
	if (!session) return c.json({ error: "not found" }, 404);
	if (session.user_email !== email) return c.json({ error: "forbidden" }, 403);
	if (session.finished_at) return c.json({ error: "already finished" }, 410);

	const { results: rows } = await c.env.DB.prepare(
		// COALESCE(ea.seq, q.number):自訂測驗跨年份時 q.number 會重複,seq 才是
		// 卷內順序;seq 為 NULL 的舊 session 退回原本的 q.number 排序(等價)。
		`SELECT q.id, q.year, q.number, q.stem, q.options_json, ea.chosen,
              ea.flagged, ea.flagged_at
       FROM exam_answers ea
       JOIN questions q ON q.id = ea.question_id
       WHERE ea.session_id = ?
       ORDER BY COALESCE(ea.seq, q.number) ASC, q.year ASC, q.number ASC`,
	)
		.bind(sid)
		.all<{
			id: string;
			year: number;
			number: number;
			stem: string;
			options_json: string;
			chosen: string | null;
			flagged: number;
			flagged_at: number | null;
		}>();

	const liveElapsed = session.running_since
		? session.elapsed_ms + (now - session.running_since)
		: session.elapsed_ms;

	return c.json({
		session_id: sid,
		started_at: session.started_at,
		elapsed_ms: liveElapsed,
		running_since: session.running_since,
		cap_ms: session.cap_ms,
		// 自訂測驗的 UI 靠這三個旗標決定計時方向、標題與 tutor 揭曉。
		// 舊 session 由 migration 0026 的 DEFAULT 落在 'year'/0/1。
		kind: session.kind,
		tutor: session.tutor,
		timed: session.timed,
		questions: rows.map((r) => ({
			id: r.id,
			year: r.year,
			number: r.number,
			stem: r.stem,
			options: optionsToRecord(r.options_json),
			chosen: r.chosen,
			// 標記(migration 0028)。舊列 DEFAULT 0 → false,不會壞。
			flagged: r.flagged === 1,
			flagged_at: r.flagged_at,
		})),
	});
});

// Pause — freeze the timer
examRoutes.post("/:sid/pause", async (c) => {
	const sid = c.req.param("sid");
	const email = c.var.email;
	const now = Date.now();

	const s = await c.env.DB.prepare(
		"SELECT user_email, finished_at, elapsed_ms, running_since FROM exam_sessions WHERE id = ?",
	)
		.bind(sid)
		.first<{
			user_email: string;
			finished_at: number | null;
			elapsed_ms: number;
			running_since: number | null;
		}>();
	if (!s) return c.json({ error: "not found" }, 404);
	if (s.user_email !== email) return c.json({ error: "forbidden" }, 403);
	if (s.finished_at) return c.json({ error: "already finished" }, 400);
	if (s.running_since === null) {
		return c.json({
			ok: true,
			elapsed_ms: s.elapsed_ms,
			running_since: null,
			already: true,
		});
	}

	const newElapsed = s.elapsed_ms + (now - s.running_since);
	await c.env.DB.prepare(
		"UPDATE exam_sessions SET elapsed_ms = ?, running_since = NULL WHERE id = ?",
	)
		.bind(newElapsed, sid)
		.run();

	return c.json({ ok: true, elapsed_ms: newElapsed, running_since: null });
});

// Resume — un-freeze
examRoutes.post("/:sid/resume", async (c) => {
	const sid = c.req.param("sid");
	const email = c.var.email;
	const now = Date.now();

	const s = await c.env.DB.prepare(
		"SELECT user_email, finished_at, elapsed_ms, running_since, cap_ms FROM exam_sessions WHERE id = ?",
	)
		.bind(sid)
		.first<{
			user_email: string;
			finished_at: number | null;
			elapsed_ms: number;
			running_since: number | null;
			cap_ms: number;
		}>();
	if (!s) return c.json({ error: "not found" }, 404);
	if (s.user_email !== email) return c.json({ error: "forbidden" }, 403);
	if (s.finished_at) return c.json({ error: "already finished" }, 400);
	if (s.running_since !== null) {
		return c.json({
			ok: true,
			elapsed_ms: s.elapsed_ms,
			running_since: s.running_since,
			already: true,
		});
	}
	// Refuse resume if already past cap — force-finish instead
	if (s.elapsed_ms >= s.cap_ms) {
		return c.json(
			{
				error: "time cap reached, must finish",
				elapsed_ms: s.elapsed_ms,
				cap_ms: s.cap_ms,
			},
			409,
		);
	}

	await c.env.DB.prepare(
		"UPDATE exam_sessions SET running_since = ? WHERE id = ?",
	)
		.bind(now, sid)
		.run();
	return c.json({ ok: true, elapsed_ms: s.elapsed_ms, running_since: now });
});

// Submit an answer (can be called multiple times to update)
examRoutes.post("/:sid/answer", async (c) => {
	const sid = c.req.param("sid");
	const email = c.var.email;

	// 冪等:重送同一 key 直接 replay,不重複 append attempts。
	const idemKey = readIdemKey(c);
	if (idemKey) {
		const hit = await idemLookup(c.env.DB, email, idemKey);
		if (hit) return c.json(hit.body as any, hit.status as any);
	}

	const body = await c.req.json<{
		question_id: string;
		chosen: string;
		elapsed_ms?: number;
	}>();

	// Ownership + active session check
	const session = await c.env.DB.prepare(
		"SELECT user_email, finished_at FROM exam_sessions WHERE id = ?",
	)
		.bind(sid)
		.first<{ user_email: string; finished_at: number | null }>();

	if (!session) return c.json({ error: "session not found" }, 404);
	if (session.user_email !== email) return c.json({ error: "forbidden" }, 403);
	if (session.finished_at)
		return c.json({ error: "session already finished" }, 400);

	// exam_answers 仍是 resume 用的「當前作答狀態」(可覆寫);attempts 則
	// append 一筆事件。改答案會產生多筆 attempt — 這是刻意的,改答案本身
	// 就是配速訊號,配速報告以 SUM(elapsed_ms) 聚合同一 (session, question)。
	const now = Date.now();
	const payload = { ok: true };
	const ops = [
		c.env.DB.prepare(
			`UPDATE exam_answers
         SET chosen = ?, answered_at = ?
         WHERE session_id = ? AND question_id = ?`,
		).bind(body.chosen, now, sid, body.question_id),
		insertAttemptOp({
			db: c.env.DB,
			email,
			questionId: body.question_id,
			chosen: body.chosen,
			isCorrect: null, // 模擬考交卷前不揭曉,判定留給 finish
			source: "exam",
			sessionId: sid,
			elapsedMs: clampElapsedMs(body.elapsed_ms),
			now,
		}),
	];
	if (idemKey) {
		ops.push(
			idemRecordOp(c.env.DB, {
				email,
				key: idemKey,
				endpoint: "POST /exam/:sid/answer",
				status: 200,
				body: payload,
				now,
			}),
		);
	}
	await c.env.DB.batch(ops);

	return c.json(payload);
});

// 交卷前的答案全量重送 —— **一趟請求,一個 batch**。
//
// 前身是前端 `submit()` 裡的 `for (...) await api.post('/answer')`:100 題就是
// 100 趟循序往返,而 `/answer` 內部還有兩趟 D1(先 SELECT 檢查 session,再
// batch 寫 exam_answers + attempts)。正式機實測**每趟 1.30 秒**,於是交卷要等
// 兩分鐘以上 —— 使用者會以為當掉,重新整理再按一次,結果是同一波裡跑了一輪半
// (量到 144 筆 elapsed_ms IS NULL 的 attempts 涵蓋 100 題)。
//
// 這裡把它壓成:一次 ownership 檢查 + 一次 batch。`/start` 本來就在用 101 條
// statement 的 batch,所以規模是驗證過的。
//
// ⚠️ **只有真的改變的答案才 append attempts。** 舊路徑對 100 題全部 append,
// 而那些事件在作答當下就已經寫過一次了 —— 同一場考試因此在 `attempts`(整個
// 站的作答真相)裡留下 100 筆 elapsed_ms 為 NULL 的重複列。舊程式自己的註解就
// 寫著「這不是一次新的作答事件」,卻仍然把它記成事件。判準用 `chosen` 是否與
// 庫裡不同,不是「有沒有送來」。
examRoutes.put("/:sid/answers", async (c) => {
	const sid = c.req.param("sid");
	const email = c.var.email;
	const now = Date.now();

	const body = await c.req
		.json<{ answers?: { question_id?: unknown; chosen?: unknown }[] }>()
		.catch(() => ({}) as { answers?: never[] });
	const incoming = Array.isArray(body.answers) ? body.answers : null;
	if (!incoming) return c.json({ error: "answers must be an array" }, 400);

	// 一場考試最多 100 題;上限放寬一點但要有,否則一個惡意 body 就能讓 batch
	// 大到打爆 worker 的 CPU 額度。
	if (incoming.length > 500) return c.json({ error: "too many answers" }, 400);

	const session = await c.env.DB.prepare(
		"SELECT user_email, finished_at FROM exam_sessions WHERE id = ?",
	)
		.bind(sid)
		.first<{ user_email: string; finished_at: number | null }>();

	if (!session) return c.json({ error: "session not found" }, 404);
	if (session.user_email !== email) return c.json({ error: "forbidden" }, 403);
	if (session.finished_at)
		return c.json({ error: "session already finished" }, 400);

	// 目前庫裡的答案 —— 拿來判斷「這一題真的改了嗎」。順帶把不屬於這場考試的
	// question_id 濾掉:UPDATE 本來就會是 no-op,但那樣就分不出「沒改」與
	// 「根本不在這場考試裡」,回傳的數字會說謊。
	const { results: current } = await c.env.DB.prepare(
		"SELECT question_id, chosen FROM exam_answers WHERE session_id = ?",
	)
		.bind(sid)
		.all<{ question_id: string; chosen: string | null }>();
	const stored = new Map((current ?? []).map((r) => [r.question_id, r.chosen]));

	const plan = planAnswerWrites(incoming, stored);

	const ops: D1PreparedStatement[] = [];
	for (const w of plan.writes) {
		ops.push(
			c.env.DB.prepare(
				`UPDATE exam_answers SET chosen = ?, answered_at = ?
           WHERE session_id = ? AND question_id = ?`,
			).bind(w.chosen, now, sid, w.question_id),
			insertAttemptOp({
				db: c.env.DB,
				email,
				questionId: w.question_id,
				chosen: w.chosen,
				isCorrect: null, // 交卷前不揭曉,判定留給 /finish
				source: "exam",
				sessionId: sid,
				elapsedMs: null, // 這是補送,不是一次計時中的作答
				now,
			}),
		);
	}

	// 全部沒變是**常態**(答案在作答當下就送出去了),那時一條 statement 都不發。
	if (ops.length > 0) await c.env.DB.batch(ops);

	return c.json({
		changed: plan.writes.length,
		unchanged: plan.unchanged,
		unknown: plan.unknown,
		invalid: plan.invalid,
	});
});

// 標記/取消標記一題(待回頭檢查)。
//
// 刻意與 /answer 分離,不共用同一個 handler:
//  - /answer 有 400ms debounce,且交卷前會把所有答案全量重送一次
//    (frontend/src/routes/Exam.tsx 的 submit()),把標記塞進去會讓
//    「只改標記」也一起重寫 chosen / answered_at,並多寫一筆 attempts。
//  - /answer 的 DB.batch() 是 exam_answers + attempts 的交易,標記
//    不該混進那條路徑。
//
// 與 /answer 另一個差異:**已交卷的 session 仍允許改標記** —— 檢討期
// 二輪複習需要,且 flagged 完全不參與計分(見 /finish)。
// 冪等:重送同值只是把同樣的 0/1 再寫一次,回傳相同 body。
examRoutes.put("/:sid/flag", async (c) => {
	const sid = c.req.param("sid");
	const email = c.var.email;
	const body = await c.req
		.json<{ question_id?: string; flagged?: boolean; at?: number }>()
		.catch(
			() => ({}) as { question_id?: string; flagged?: boolean; at?: number },
		);
	if (!body.question_id || typeof body.flagged !== "boolean") {
		return c.json({ error: "question_id and flagged required" }, 400);
	}

	const session = await c.env.DB.prepare(
		"SELECT user_email FROM exam_sessions WHERE id = ?",
	)
		.bind(sid)
		.first<{ user_email: string }>();
	if (!session) return c.json({ error: "session not found" }, 404);
	if (session.user_email !== email) return c.json({ error: "forbidden" }, 403);

	const at = typeof body.at === "number" ? body.at : Date.now();
	// UPDATE(非 upsert):/start 與 /custom 都已為每題預建列,用 UPDATE 順便
	// 擋掉不屬於這場考試的 question_id,避免被塞進假列。
	const res = await c.env.DB.prepare(
		`UPDATE exam_answers SET flagged = ?, flagged_at = ?
       WHERE session_id = ? AND question_id = ?`,
	)
		.bind(body.flagged ? 1 : 0, at, sid, body.question_id)
		.run();
	if (!res.meta.changes)
		return c.json({ error: "question not in session" }, 404);

	return c.json({ ok: true, flagged: body.flagged, flagged_at: at });
});

// Finish the exam — computes score, freezes timer
examRoutes.post("/:sid/finish", async (c) => {
	const sid = c.req.param("sid");
	const email = c.var.email;
	const now = Date.now();

	const session = await c.env.DB.prepare(
		"SELECT * FROM exam_sessions WHERE id = ?",
	)
		.bind(sid)
		.first<
			ExamSession & {
				elapsed_ms: number;
				running_since: number | null;
				cap_ms: number;
			}
		>();

	if (!session) return c.json({ error: "session not found" }, 404);
	if (session.user_email !== email) return c.json({ error: "forbidden" }, 403);
	if (session.finished_at) return c.json({ error: "already finished" }, 400);

	// Compute correctness AND snapshot the canonical answer at finish time so
	// a later challenge promotion doesn't retroactively rescore this attempt.
	await c.env.DB.prepare(
		`UPDATE exam_answers
       SET correct_answer_at_finish = (SELECT answer FROM questions WHERE id = exam_answers.question_id),
           is_correct = CASE
             WHEN chosen = (SELECT answer FROM questions WHERE id = exam_answers.question_id)
             THEN 1 ELSE 0 END
       WHERE session_id = ?`,
	)
		.bind(sid)
		.run();

	// Backfill the attempt log's verdict now that the answer is revealed.
	// Uses the same correct_answer_at_finish snapshot so a later challenge
	// promotion doesn't retroactively rewrite this session's history.
	await c.env.DB.prepare(
		`UPDATE attempts
       SET is_correct = CASE
             WHEN chosen = (SELECT COALESCE(ea.correct_answer_at_finish, q.answer)
                            FROM exam_answers ea JOIN questions q ON q.id = ea.question_id
                            WHERE ea.session_id = attempts.session_id
                              AND ea.question_id = attempts.question_id)
             THEN 1 ELSE 0 END
       WHERE session_id = ? AND is_correct IS NULL`,
	)
		.bind(sid)
		.run();

	const correct = await c.env.DB.prepare(
		`SELECT COUNT(*) as n FROM exam_answers WHERE session_id = ? AND is_correct = 1`,
	)
		.bind(sid)
		.first<{ n: number }>();

	// Finalize elapsed time — clamp to the session's cap so abandoned
	// sessions resumed past the cap don't get an unbounded duration.
	const liveElapsed = session.running_since
		? session.elapsed_ms + (now - session.running_since)
		: session.elapsed_ms;
	const finalMs = Math.min(liveElapsed, session.cap_ms);
	const duration = Math.floor(finalMs / 1000);

	await c.env.DB.prepare(
		`UPDATE exam_sessions
       SET finished_at = ?, score = ?, duration_sec = ?,
           elapsed_ms = ?, running_since = NULL
       WHERE id = ?`,
	)
		.bind(now, correct!.n, duration, finalMs, sid)
		.run();

	return c.json({ score: correct!.n, duration_sec: duration });
});

// Get session results
examRoutes.get("/:sid", async (c) => {
	const sid = c.req.param("sid");
	const email = c.var.email;

	const session = await c.env.DB.prepare(
		"SELECT * FROM exam_sessions WHERE id = ?",
	)
		.bind(sid)
		.first<ExamSession>();

	if (!session) return c.json({ error: "not found" }, 404);
	if (session.user_email !== email) return c.json({ error: "forbidden" }, 403);

	// SUM (not MAX) over attempts: changing an answer appends another attempt,
	// and the total is what the question actually cost. Sessions predating
	// migration 0023 have no attempts → NULL → the UI shows "—".
	const { results: answers } = await c.env.DB.prepare(
		`SELECT ea.question_id, ea.chosen, ea.is_correct, ea.answered_at,
              ea.flagged, ea.flagged_at,
              q.year, q.number, q.stem, q.options_json,
              COALESCE(ea.correct_answer_at_finish, q.answer) AS correct_answer,
              t.elapsed_ms, rp.last_chosen AS review_last_chosen
       FROM exam_answers ea
       JOIN questions q ON q.id = ea.question_id
       LEFT JOIN review_progress rp
              ON rp.question_id = ea.question_id AND rp.user_email = ?
       LEFT JOIN (
         SELECT question_id, SUM(elapsed_ms) AS elapsed_ms
         FROM attempts WHERE session_id = ? AND elapsed_ms IS NOT NULL
         GROUP BY question_id
       ) t ON t.question_id = ea.question_id
       WHERE ea.session_id = ?
       ORDER BY COALESCE(ea.seq, q.number) ASC, q.year ASC, q.number ASC`,
	)
		.bind(sid, email, sid)
		.all<{ options_json: string }>();

	// 選項文字跟著成績一起回,不另外開一支端點:它就在同一列 questions 上,
	// 多一個欄位的成本是零,而逐題懶載入是每展開一題一趟請求 —— 檢討時展開的
	// 是**大部分**題目,那等於把 /stats 那條「100 題就是 100 個 request」的理由
	// 原封不動搬過來一次。/state 本來就是這樣把整份考卷送出去的。
	return c.json({
		session,
		answers: (answers ?? []).map(({ options_json, ...a }: any) => ({
			...a,
			options: optionsToRecord(options_json),
		})),
	});
});

// 把這次模擬考的結果登記進複習進度(`review_progress`)。
//
// 為什麼需要它:模擬考只寫 `exam_answers` 與 `attempts`,**從不碰
// `review_progress`** —— 而 `/q/:id` 的「我的作答」讀的正是後者。所以考完之後
// 打開任何一題,看到的是你上一次在複習模式答的那個,連 ✓/✗ 都是舊的。回報的
// 原話是「他對答案,卻用的是我在複習 mode 時的答案」。
//
// 為什麼是**明確的動作**而不是自動同步:「清除本題作答紀錄」(reviewRoutes 的
// DELETE /answer/:id)只刪 `review_progress`,`attempts` 原封不動。所以若改成
// 「`/q/:id` 自動讀最新一筆 attempt」,清除會靜靜失效 —— 清完重整,答案又回來
// 了。保住那個功能就得再加墓碑欄位,而 `attempts` 是全站作答真相、不能刪。
//
// ⚠️ **只登記考對的,而且只動 last_*,不碰 times_seen / times_correct。**
// 前者讓複習紀錄維持「目前最好的狀態」,不會因為一次考差把以前答對的拉下來;
// 後者是刻意的:那兩個欄位餵的是到期佇列與熟練度統計,一次批次登記把它們整批
// 加一,等於用一個看起來只是「同步顯示」的按鈕去重排整個複習排程。
//
// 但 `last_correct` 本身就會影響 `/weakness-map` 的錯題池
// (`last_correct = 0 OR times_correct * 2 < times_seen`)—— 那是這個功能要的:
// 已經考對的題目不該一直被丟回來。
examRoutes.post("/:sid/apply-to-review", async (c) => {
	const sid = c.req.param("sid");
	const email = c.var.email;
	const now = Date.now();

	const body = await c.req
		.json<{ question_ids?: unknown }>()
		.catch(() => ({}) as { question_ids?: unknown });
	const requested = Array.isArray(body.question_ids)
		? body.question_ids.filter((x): x is string => typeof x === "string")
		: undefined;

	const session = await c.env.DB.prepare(
		"SELECT user_email, finished_at FROM exam_sessions WHERE id = ?",
	)
		.bind(sid)
		.first<{ user_email: string; finished_at: number | null }>();
	if (!session) return c.json({ error: "session not found" }, 404);
	if (session.user_email !== email) return c.json({ error: "forbidden" }, 403);
	// 沒交卷就沒有 is_correct —— 這時候「登記考對的」沒有東西可依據。
	if (!session.finished_at) return c.json({ error: "session not finished" }, 400);

	const { results } = await c.env.DB.prepare(
		`SELECT ea.question_id, ea.chosen, ea.is_correct,
            rp.last_chosen AS review_last_chosen
       FROM exam_answers ea
       LEFT JOIN review_progress rp
              ON rp.question_id = ea.question_id AND rp.user_email = ?
      WHERE ea.session_id = ?`,
	)
		.bind(email, sid)
		.all<ExamAnswerRow>();

	const plan = planApplyToReview(results ?? [], requested);

	// times_seen / times_correct 在新列上是 0:那是「複習模式看過幾次」,而這一題
	// 確實一次都沒有(它是在模擬考裡答的)。欄位各自說各自的話,不互相冒充。
	const ops = plan.apply.map((a) =>
		c.env.DB.prepare(
			`INSERT INTO review_progress
         (user_email, question_id, times_seen, times_correct, last_seen_at, last_chosen, last_correct)
       VALUES (?, ?, 0, 0, ?, ?, 1)
       ON CONFLICT(user_email, question_id) DO UPDATE SET
         last_seen_at = excluded.last_seen_at,
         last_chosen  = excluded.last_chosen,
         last_correct = 1`,
		).bind(email, a.question_id, now, a.chosen),
	);
	if (ops.length > 0) await c.env.DB.batch(ops);

	return c.json({
		applied: plan.apply.map((a) => a.question_id),
		skipped_wrong: plan.skipped_wrong,
		skipped_already: plan.skipped_already,
		unknown: plan.unknown,
	});
});

// Pacing report for one finished session — first-half vs second-half
// average time, plus the slowest questions. Sessions with no timing data
// (pre-0023) return n: 0 rather than erroring.
examRoutes.get("/:sid/pacing", async (c) => {
	const sid = c.req.param("sid");
	const email = c.var.email;

	const session = await c.env.DB.prepare(
		"SELECT user_email FROM exam_sessions WHERE id = ?",
	)
		.bind(sid)
		.first<{ user_email: string }>();

	if (!session) return c.json({ error: "not found" }, 404);
	if (session.user_email !== email) return c.json({ error: "forbidden" }, 403);

	// ORDER BY first-touch time = answering order, NOT question number.
	const { results: rows } = await c.env.DB.prepare(
		`SELECT a.question_id, q.number, SUM(a.elapsed_ms) AS ms
       FROM attempts a
       JOIN questions q ON q.id = a.question_id
       WHERE a.session_id = ? AND a.elapsed_ms IS NOT NULL
       GROUP BY a.question_id
       ORDER BY MIN(a.created_at)`,
	)
		.bind(sid)
		.all<{ question_id: string; number: number; ms: number }>();

	const times = rows.map((r) => r.ms);
	const split = pacingSplit(times);
	const slowest = [...rows]
		.sort((a, b) => b.ms - a.ms)
		.slice(0, 5)
		.map((r) => ({ question_id: r.question_id, number: r.number, ms: r.ms }));

	return c.json({
		n: times.length,
		first_half_avg_ms: split ? Math.round(split.firstHalfAvg) : null,
		second_half_avg_ms: split ? Math.round(split.secondHalfAvg) : null,
		delta_pct: split ? split.deltaPct : null,
		median_ms: median(times),
		slowest,
	});
});

// Delete one of my sessions (works for in-progress or finished).
// exam_answers cascades via ON DELETE CASCADE.
examRoutes.delete("/:sid", async (c) => {
	const sid = c.req.param("sid");
	const email = c.var.email;
	const owner = await c.env.DB.prepare(
		"SELECT user_email FROM exam_sessions WHERE id = ?",
	)
		.bind(sid)
		.first<{ user_email: string }>();
	if (!owner) return c.json({ error: "not found" }, 404);
	if (owner.user_email !== email) return c.json({ error: "forbidden" }, 403);
	await c.env.DB.prepare("DELETE FROM exam_sessions WHERE id = ?")
		.bind(sid)
		.run();
	return c.json({ ok: true });
});

// My exam history
examRoutes.get("/", async (c) => {
	const email = c.var.email;
	const { results } = await c.env.DB.prepare(
		`SELECT * FROM exam_sessions
       WHERE user_email = ?
       ORDER BY started_at DESC
       LIMIT 50`,
	)
		.bind(email)
		.all();
	return c.json(results);
});

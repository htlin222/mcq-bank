import { Hono } from "hono";
import type { D1Database } from "@cloudflare/workers-types";
import type { AppContext } from "../types";
import { uuid } from "../lib/db";
import { gradeSmear, type AcceptedTerm } from "../lib/smear-grade";
import { pickSmearSet, type PoolItem } from "../lib/smear-pick";
import { pickMcqOptions, pickCorrectOptionLabel, type McqCandidate } from "../lib/smear-mcq";
import { ftsQuery } from "../lib/fts-query";
import { chunkParams, D1_MAX_PARAMS } from "../lib/sql-params";

export const smearRoutes = new Hono<AppContext>();

// 七個主題,順序同 migrations/0043_smear.sql 的欄位註解。/meta 與抽題共用
// 同一份清單 + 同一支 computeTopicWeights —— 避免兩處各自維護一份比例算法,
// 而抽題吃到的比例跟 /meta 顯示的比例對不上(那種漂移使用者看不出來)。
const TOPICS = [
	"myeloid",
	"lymphoid",
	"normal_reactive",
	"rbc",
	"platelet",
	"infection",
	"other",
];

// 'submission' 是社群投稿經 admin 核准後寫進 smear_questions 的來源
// (worker/routes/smear-community.ts 的 POST /submissions/:id/approve)。
// 核准本身就是那道信任閘門 —— 通過之後跟 exam/ash 同等對待,包含在預設
// 抽題來源裡,不必等一個「只有投稿」的額外篩選才會被抽到。
const SOURCES = ["exam", "ash", "po", "submission"];

type SmearSessionRow = {
	id: string;
	user_email: string;
	mode: "review" | "exam";
	config_json: string;
	question_ids: string;
	started_at: number;
	finished_at: number | null;
	score: number | null;
	max_score: number | null;
	spelling_ok: number | null;
	lay_count: number | null;
};

type SessionQuestionInfo = {
	id: string;
	dx_id: string;
	source: string;
	image_key_view: string;
	image_key_full: string;
	prompt: string | null;
	image_note: string | null;
	topic: string;
	qtype: string;
	canonical_long: string;
};

/** dxCount + topicWeights,依 smear_dx 的當下分布正規化到總和 1。 */
async function computeTopicWeights(
	db: D1Database,
): Promise<{ dxCount: number; topicWeights: Record<string, number> }> {
	const { results } = await db
		.prepare("SELECT topic, COUNT(*) as n FROM smear_dx GROUP BY topic")
		.all<{ topic: string; n: number }>();

	const counts: Record<string, number> = {};
	for (const t of TOPICS) counts[t] = 0;
	let dxCount = 0;
	for (const r of results ?? []) {
		counts[r.topic] = (counts[r.topic] ?? 0) + r.n;
		dxCount += r.n;
	}

	const topicWeights: Record<string, number> = {};
	for (const t of TOPICS) {
		topicWeights[t] = dxCount > 0 ? counts[t] / dxCount : 0;
	}
	return { dxCount, topicWeights };
}

/**
 * ⚠️ `smear_questions.id` 對 ASH 來源的題目直接內嵌了 dx slug(例如
 * 'ash-hairy_cell_leukemia-63662'),不是 migration 註解講的 'ash-66486' 那種
 * 純數字格式 —— 實際匯入的 274 筆(全部 ash 來源、佔題庫 57%)都是這樣,
 * Phase A 的資料跟 schema 註解對不上。
 *
 * POST /sessions 與 GET /sessions/:id 都會把 id 原樣送回前端,而全真模式的
 * 判定要到 /finish 才能揭曉:原樣送出這個 id,等於用 id 字串本身把答案洩漏
 * 出去,完全繞過下面 my_tier/my_score 那道閘 —— 使用者一開考就知道一半以上
 * 的題目答案,不必回答任何一題。對尚未揭曉的題目一律回傳「陣列裡第幾個」的
 * 不透明代號,揭曉之後(複習模式全程 / 全真模式 finish 之後)才回真正的 id。
 */
function clientQuestionId(revealed: boolean, realId: string, idx: number): string {
	return revealed ? realId : `#${idx}`;
}

/** clientQuestionId 的反函式 —— 把使用者送回來的 questionId 解回陣列位置。
 *  複習模式(或已 finish 的全真模式)client 手上是真正的 id,直接比對得到;
 *  全真模式 finish 之前 client 只有上面那個 `#idx` 代號,要另外解析。 */
function resolveQuestionIdx(raw: string, questionIds: string[]): number {
	const direct = questionIds.indexOf(raw);
	if (direct >= 0) return direct;
	const m = /^#(\d+)$/.exec(raw);
	if (m) {
		const i = Number(m[1]);
		if (i >= 0 && i < questionIds.length) return i;
	}
	return -1;
}

/**
 * 依 question_ids 的順序組出「不含答案」的題目資訊 map。GET /sessions/:id
 * 與 POST /finish 的檢討 breakdown 都要用同一份 join,不各寫一次 —— 抄漏的
 * 症狀是兩處看到的 topic / canonical 對不起來。
 */
async function loadSessionQuestions(
	db: D1Database,
	questionIds: string[],
): Promise<Map<string, SessionQuestionInfo>> {
	const map = new Map<string, SessionQuestionInfo>();
	if (questionIds.length === 0) return map;
	// ⚠️ 一場全真模式最多可以有 200 題(見 POST /sessions 的 Math.min(200, nRaw)),
	// 而 D1 對單一陳述式綁的參數數量有上限(worker/lib/sql-params.ts 的
	// D1_MAX_PARAMS,同一個坑 export.ts 已經踩過一次)。原本一次性
	// `IN (?,?,...×200)` 在 200 題的場次會直接 500(D1_ERROR: too many SQL
	// variables),而且只有大場次才會踩到 —— 小規模手測完全看不出來。
	for (const part of chunkParams(questionIds, D1_MAX_PARAMS)) {
		const placeholders = part.map(() => "?").join(",");
		const { results } = await db
			.prepare(
				`SELECT sq.id, sq.dx_id, sq.source, sq.image_key_view, sq.image_key_full,
              sq.prompt, sq.image_note, sd.topic, sd.qtype, sd.canonical_long
       FROM smear_questions sq
       JOIN smear_dx sd ON sd.id = sq.dx_id
       WHERE sq.id IN (${placeholders})`,
			)
			.bind(...part)
			.all<SessionQuestionInfo>();
		for (const r of results ?? []) map.set(r.id, r);
	}
	return map;
}

// ---------------------------------------------------------------------------
// GET /api/smear/meta
// ---------------------------------------------------------------------------
smearRoutes.get("/meta", async (c) => {
	const { dxCount, topicWeights } = await computeTopicWeights(c.env.DB);

	const { results: sourceRows } = await c.env.DB.prepare(
		"SELECT source, COUNT(*) as n FROM smear_questions GROUP BY source",
	).all<{ source: string; n: number }>();
	const sourceCounts: Record<string, number> = {};
	for (const r of sourceRows ?? []) sourceCounts[r.source] = r.n;

	return c.json({ dxCount, topicWeights, sourceCounts, topics: TOPICS });
});

// ---------------------------------------------------------------------------
// POST /api/smear/sessions —— 抽題,固定順序寫進 question_ids
// ---------------------------------------------------------------------------
smearRoutes.post("/sessions", async (c) => {
	const email = c.var.email;
	// ⚠️ `form` 只是原樣存進 config_json 給前端顯示當初選了什麼,不影響抽題或
	// 判定 —— gradeSmear() 沒有 form 篩選,pickSmearSet() 也不吃這個參數。
	// 想要「只考長名詞」之類的功能,得先幫兩個純函式加上 form 篩選再接上來。
	const body = await c.req
		.json<{
			mode?: string;
			n?: number;
			form?: "long" | "abbrev" | "any";
			topics?: string[];
			sources?: string[];
			limitSec?: number;
		}>()
		.catch(() => ({}) as Record<string, never>);

	if (body.mode !== "review" && body.mode !== "exam") {
		return c.json({ error: "mode must be 'review' or 'exam'" }, 400);
	}
	const mode = body.mode;

	const nRaw = Math.floor(Number(body.n));
	const n = Number.isFinite(nRaw) && nRaw > 0 ? Math.min(200, nRaw) : 50;

	const topics =
		Array.isArray(body.topics) &&
		body.topics.filter((t) => TOPICS.includes(t)).length > 0
			? body.topics.filter((t) => TOPICS.includes(t))
			: TOPICS;

	const sources =
		Array.isArray(body.sources) &&
		body.sources.filter((s) => SOURCES.includes(s)).length > 0
			? body.sources.filter((s) => SOURCES.includes(s))
			// 'po' 還沒有真正匯入的資料,留在預設之外;'submission' 已經是核准
			// 過的活題目,理由同上面 SOURCES 常數的註解。
			: ["exam", "ash", "submission"];

	const sourcePlaceholders = sources.map(() => "?").join(",");
	const topicPlaceholders = topics.map(() => "?").join(",");
	const { results: poolRows } = await c.env.DB.prepare(
		`SELECT sq.id, sd.topic
       FROM smear_questions sq
       JOIN smear_dx sd ON sd.id = sq.dx_id
       WHERE sq.source IN (${sourcePlaceholders}) AND sd.topic IN (${topicPlaceholders})`,
	)
		.bind(...sources, ...topics)
		.all<{ id: string; topic: string }>();
	const pool: PoolItem[] = (poolRows ?? []).map((r) => ({
		id: r.id,
		topic: r.topic,
	}));

	// 避開上一場考過的題 —— best-effort,pickSmearSet 自己處理湊不滿的情況。
	const lastSession = await c.env.DB.prepare(
		"SELECT question_ids FROM smear_sessions WHERE user_email = ? ORDER BY started_at DESC LIMIT 1",
	)
		.bind(email)
		.first<{ question_ids: string }>();
	let exclude = new Set<string>();
	if (lastSession) {
		try {
			exclude = new Set(JSON.parse(lastSession.question_ids) as string[]);
		} catch {
			exclude = new Set();
		}
	}

	const { topicWeights } = await computeTopicWeights(c.env.DB);
	const pickedIds = pickSmearSet(pool, n, topicWeights, exclude, Math.random);

	if (pickedIds.length === 0) {
		return c.json({ error: "no questions available for that selection" }, 404);
	}

	const sessionId = uuid();
	const now = Date.now();
	await c.env.DB.prepare(
		`INSERT INTO smear_sessions (id, user_email, mode, config_json, question_ids, started_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
	)
		.bind(sessionId, email, mode, JSON.stringify(body), JSON.stringify(pickedIds), now)
		.run();

	// review 模式全程揭曉;全真模式要到 /finish 才揭曉 —— 剛開考就不能把
	// (可能內嵌 dx 的)真正 id 送出去,見 clientQuestionId 上方註解。
	const revealed = mode === "review";
	return c.json({
		id: sessionId,
		question_ids: pickedIds.map((id, i) => clientQuestionId(revealed, id, i)),
	});
});

// ---------------------------------------------------------------------------
// GET /api/smear/sessions —— 這個使用者的歷史(不含 question_ids 明細)
//
// 註冊在 /sessions/:id 之前沒有必要 —— 兩者的路徑片段數不同(1 vs 2),
// Hono 不會混淆,但仍緊鄰著寫方便閱讀。
// ---------------------------------------------------------------------------
smearRoutes.get("/sessions", async (c) => {
	const email = c.var.email;
	const { results } = await c.env.DB.prepare(
		`SELECT id, mode, started_at, finished_at, score, max_score, question_ids
       FROM smear_sessions WHERE user_email = ? ORDER BY started_at DESC LIMIT 50`,
	)
		.bind(email)
		.all<{
			id: string;
			mode: string;
			started_at: number;
			finished_at: number | null;
			score: number | null;
			max_score: number | null;
			question_ids: string;
		}>();

	const items = (results ?? []).map((r) => {
		let question_count = 0;
		try {
			question_count = (JSON.parse(r.question_ids) as string[]).length;
		} catch {
			question_count = 0;
		}
		return {
			id: r.id,
			mode: r.mode,
			started_at: r.started_at,
			finished_at: r.finished_at,
			score: r.score,
			max_score: r.max_score,
			question_count,
		};
	});

	return c.json({ items });
});

// ---------------------------------------------------------------------------
// GET /api/smear/sessions/:id —— 題目 payload,不含答案
// ---------------------------------------------------------------------------
smearRoutes.get("/sessions/:id", async (c) => {
	const sid = c.req.param("id");
	const email = c.var.email;

	const session = await c.env.DB.prepare(
		"SELECT * FROM smear_sessions WHERE id = ? AND user_email = ?",
	)
		.bind(sid, email)
		.first<SmearSessionRow>();
	if (!session) return c.json({ error: "not found" }, 404);

	let questionIds: string[] = [];
	try {
		questionIds = JSON.parse(session.question_ids);
	} catch {
		questionIds = [];
	}

	const qMap = await loadSessionQuestions(c.env.DB, questionIds);
	const { results: answerRows } = await c.env.DB.prepare(
		"SELECT question_id, tier, score FROM smear_answers WHERE session_id = ?",
	)
		.bind(sid)
		.all<{ question_id: string; tier: string | null; score: number | null }>();
	const aMap = new Map((answerRows ?? []).map((r) => [r.question_id, r]));

	// ⚠️ 絕不把 canonical_long 或 smear_terms 放進這份 payload —— 那就是答案,
	// 這支是考卷,不是解答卷。
	//
	// ⚠️ exam 模式在 finish 之前也不揭露 my_tier/my_score —— 否則作答後單純
	// reload 這支端點就能看到對錯,等於繞過「判定要到 /finish 才給」那條硬規則。
	// review 模式在 /answer 當下就已經把完整判定回給 client 了,這裡再帶一次
	// 只是讓 reload 恢復進度,不算多揭露什麼。
	//
	// ⚠️ 同一道閘也要蓋住 `id` 與 `dx_id` 本身 —— 見 clientQuestionId 上方註解,
	// ASH 來源的 id 直接內嵌 dx slug,原樣送出等於用 id 洩漏答案。
	const revealGrade = session.mode === "review" || !!session.finished_at;
	const questions = questionIds
		.map((qid, i) => {
			const q = qMap.get(qid);
			if (!q) return null;
			const a = aMap.get(qid);
			return {
				id: clientQuestionId(revealGrade, q.id, i),
				dx_id: revealGrade ? q.dx_id : undefined,
				source: q.source,
				image_key_view: q.image_key_view,
				image_key_full: q.image_key_full,
				prompt: q.prompt,
				image_note: q.image_note,
				topic: q.topic,
				qtype: q.qtype,
				answered: !!a,
				my_tier: revealGrade ? (a?.tier ?? undefined) : undefined,
				my_score: revealGrade ? (a?.score ?? undefined) : undefined,
			};
		})
		.filter((x): x is NonNullable<typeof x> => x !== null);

	let config: unknown = null;
	try {
		config = JSON.parse(session.config_json);
	} catch {
		config = null;
	}

	return c.json({
		id: session.id,
		mode: session.mode,
		config,
		started_at: session.started_at,
		finished_at: session.finished_at,
		questions,
	});
});

// ---------------------------------------------------------------------------
// POST /api/smear/sessions/:id/answer
//
// ⚠️ review 模式回完整判定 + 可接受清單;exam 模式只回 {ok:true} —— 判定
// 已經算好、寫進 D1,但要到 /finish 才揭曉,不然等於把答案送到瀏覽器。
// ---------------------------------------------------------------------------
smearRoutes.post("/sessions/:id/answer", async (c) => {
	const sid = c.req.param("id");
	const email = c.var.email;

	const session = await c.env.DB.prepare(
		"SELECT id, mode, finished_at, question_ids FROM smear_sessions WHERE id = ? AND user_email = ?",
	)
		.bind(sid, email)
		.first<{
			id: string;
			mode: "review" | "exam";
			finished_at: number | null;
			question_ids: string;
		}>();
	if (!session) return c.json({ error: "not found" }, 404);
	if (session.finished_at) {
		return c.json({ error: "session already finished" }, 400);
	}

	const body = await c.req
		.json<{ questionId?: string; boxes?: string[]; hintUsed?: string }>()
		.catch(() => ({}) as Record<string, never>);
	if (!body.questionId || !Array.isArray(body.boxes)) {
		return c.json({ error: "questionId and boxes are required" }, 400);
	}

	let questionIds: string[] = [];
	try {
		questionIds = JSON.parse(session.question_ids);
	} catch {
		questionIds = [];
	}
	// body.questionId may be the real smear_questions.id (review mode, or an
	// already-revealed exam session) or the opaque `#idx` token handed out by
	// GET/POST /sessions while exam-mode grading is still withheld — see
	// clientQuestionId/resolveQuestionIdx above.
	const idx = resolveQuestionIdx(body.questionId, questionIds);
	if (idx < 0) {
		return c.json({ error: "question is not part of this session" }, 400);
	}
	const realQuestionId = questionIds[idx];

	const q = await c.env.DB.prepare(
		`SELECT sq.dx_id, sd.canonical_long
       FROM smear_questions sq JOIN smear_dx sd ON sd.id = sq.dx_id
       WHERE sq.id = ?`,
	)
		.bind(realQuestionId)
		.first<{ dx_id: string; canonical_long: string }>();
	if (!q) return c.json({ error: "question not found" }, 404);

	const { results: termRows } = await c.env.DB.prepare(
		"SELECT text, tier FROM smear_terms WHERE dx_id = ? AND status = 'accepted'",
	)
		.bind(q.dx_id)
		.all<{ text: string; tier: "full" | "half" | "lay" }>();
	const terms: AcceptedTerm[] = (termRows ?? []).map((t) => ({
		text: t.text,
		tier: t.tier,
	}));

	const grade = gradeSmear(body.boxes, terms, q.canonical_long);
	const now = Date.now();

	await c.env.DB.prepare(
		`INSERT INTO smear_answers
       (session_id, question_id, idx, typed_json, tier, score, spelling_errors_json, hint_used, answered_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (session_id, question_id) DO UPDATE SET
       idx = excluded.idx,
       typed_json = excluded.typed_json,
       tier = excluded.tier,
       score = excluded.score,
       spelling_errors_json = excluded.spelling_errors_json,
       hint_used = excluded.hint_used,
       answered_at = excluded.answered_at`,
	)
		.bind(
			sid,
			realQuestionId,
			idx,
			JSON.stringify(body.boxes),
			grade.tier,
			grade.score,
			JSON.stringify(grade.spellingErrors),
			body.hintUsed ?? null,
			now,
		)
		.run();

	if (session.mode === "review") {
		return c.json({
			tier: grade.tier,
			score: grade.score,
			matched: grade.matched,
			canonical: grade.canonical,
			spellingErrors: grade.spellingErrors,
			acceptedTerms: terms,
		});
	}
	return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// POST /api/smear/sessions/:id/mc-options —— 「看選項」提示,複習模式限定
//
// 只回傳洗牌過的選項文字陣列,不帶任何能推出「哪一個是正解」的欄位 ——
// 同 /answer 端點檔頭那套對抗性審查的精神。全真模式刻意拒絕:那個模式的
// 全部價值建立在交卷前不揭曉任何判定資訊上,而這支端點的回應本身就會讓
// 正解的文字出現在畫面上,跟「全真模式全程不揭曉」直接衝突。
// ---------------------------------------------------------------------------
smearRoutes.post("/sessions/:id/mc-options", async (c) => {
	const sid = c.req.param("id");
	const email = c.var.email;

	const session = await c.env.DB.prepare(
		"SELECT id, mode, question_ids FROM smear_sessions WHERE id = ? AND user_email = ?",
	)
		.bind(sid, email)
		.first<{ id: string; mode: "review" | "exam"; question_ids: string }>();
	if (!session) return c.json({ error: "not found" }, 404);
	if (session.mode !== "review") {
		return c.json({ error: "mc-options only available in review mode" }, 403);
	}

	const body = await c.req
		.json<{ questionId?: string }>()
		.catch(() => ({}) as Record<string, never>);
	if (!body.questionId) {
		return c.json({ error: "questionId is required" }, 400);
	}

	let questionIds: string[] = [];
	try {
		questionIds = JSON.parse(session.question_ids);
	} catch {
		questionIds = [];
	}
	const idx = resolveQuestionIdx(body.questionId, questionIds);
	if (idx < 0) {
		return c.json({ error: "question is not part of this session" }, 400);
	}
	const realQuestionId = questionIds[idx];

	const q = await c.env.DB.prepare(
		`SELECT sq.dx_id, sd.canonical_long, sd.topic, sd.qtype
       FROM smear_questions sq JOIN smear_dx sd ON sd.id = sq.dx_id
       WHERE sq.id = ?`,
	)
		.bind(realQuestionId)
		.first<{ dx_id: string; canonical_long: string; topic: string; qtype: string }>();
	if (!q) return c.json({ error: "question not found" }, 404);

	// 正解選項的文字不能直接用 canonical_long —— 它常帶括號補充內容,字數跟
	// smear_terms 裡登記的 full 級用詞不一致,而 gradeSmear() 只認 smear_terms。
	// 改成直接查 full 級的詞當選項文字,保證使用者選到「顯示的正解」時能通過
	// gradeSmear()。見 worker/lib/smear-mcq.ts 的 pickCorrectOptionLabel()。
	const { results: correctTermRows } = await c.env.DB.prepare(
		"SELECT text, tier, form FROM smear_terms WHERE dx_id = ? AND status = 'accepted'",
	)
		.bind(q.dx_id)
		.all<{ text: string; tier: string; form: string }>();
	const correctLabel = pickCorrectOptionLabel(correctTermRows ?? [], q.canonical_long);

	const { results: poolRows } = await c.env.DB.prepare(
		"SELECT id, canonical_long, topic, qtype FROM smear_dx WHERE id != ?",
	)
		.bind(q.dx_id)
		.all<{ id: string; canonical_long: string; topic: string; qtype: string }>();

	const pool: McqCandidate[] = (poolRows ?? []).map((r) => ({
		id: r.id,
		topic: r.topic,
		qtype: r.qtype,
		label: r.canonical_long,
	}));

	const options = pickMcqOptions(
		{ id: q.dx_id, topic: q.topic, qtype: q.qtype, label: correctLabel },
		pool,
		Math.random,
	);

	return c.json({ options });
});

// ---------------------------------------------------------------------------
// POST /api/smear/sessions/:id/finish
//
// 已交過卷再打一次不重算 —— 直接把當初寫進 smear_sessions 的彙總數字原樣
// 回傳,並用現有的 smear_answers 重建 breakdown(那些列本來就不會再變)。
// ---------------------------------------------------------------------------
smearRoutes.post("/sessions/:id/finish", async (c) => {
	const sid = c.req.param("id");
	const email = c.var.email;

	const session = await c.env.DB.prepare(
		"SELECT * FROM smear_sessions WHERE id = ? AND user_email = ?",
	)
		.bind(sid, email)
		.first<SmearSessionRow>();
	if (!session) return c.json({ error: "not found" }, 404);

	let questionIds: string[] = [];
	try {
		questionIds = JSON.parse(session.question_ids);
	} catch {
		questionIds = [];
	}

	let score = session.score ?? 0;
	let maxScore = session.max_score ?? questionIds.length;
	let spellingOk = session.spelling_ok ?? 0;
	let layCount = session.lay_count ?? 0;

	if (!session.finished_at) {
		const { results: answerRows } = await c.env.DB.prepare(
			"SELECT tier, score, spelling_errors_json FROM smear_answers WHERE session_id = ?",
		)
			.bind(sid)
			.all<{
				tier: string | null;
				score: number | null;
				spelling_errors_json: string | null;
			}>();

		score = 0;
		spellingOk = 0;
		layCount = 0;
		for (const r of answerRows ?? []) {
			score += r.score ?? 0;
			if (r.tier === "full") {
				let errs: unknown = [];
				try {
					errs = r.spelling_errors_json ? JSON.parse(r.spelling_errors_json) : [];
				} catch {
					errs = [];
				}
				if (Array.isArray(errs) && errs.length === 0) spellingOk += 1;
			}
			if (r.tier === "lay") layCount += 1;
		}
		maxScore = questionIds.length;

		const now = Date.now();
		await c.env.DB.prepare(
			`UPDATE smear_sessions
         SET finished_at = ?, score = ?, max_score = ?, spelling_ok = ?, lay_count = ?
       WHERE id = ? AND user_email = ?`,
		)
			.bind(now, score, maxScore, spellingOk, layCount, sid, email)
			.run();
	}

	// 交卷後的檢討畫面 —— 這是 exam 模式第一次看到判定結果的時刻。
	const qMap = await loadSessionQuestions(c.env.DB, questionIds);
	const { results: answerDetailRows } = await c.env.DB.prepare(
		`SELECT question_id, typed_json, tier, score, spelling_errors_json
       FROM smear_answers WHERE session_id = ?`,
	)
		.bind(sid)
		.all<{
			question_id: string;
			typed_json: string;
			tier: string | null;
			score: number | null;
			spelling_errors_json: string | null;
		}>();
	const aMap = new Map((answerDetailRows ?? []).map((r) => [r.question_id, r]));

	const breakdown = questionIds.map((qid) => {
		const q = qMap.get(qid);
		const a = aMap.get(qid);
		let typed: unknown[] = [];
		let spellingErrors: unknown[] = [];
		try {
			typed = a?.typed_json ? JSON.parse(a.typed_json) : [];
		} catch {
			typed = [];
		}
		try {
			spellingErrors = a?.spelling_errors_json
				? JSON.parse(a.spelling_errors_json)
				: [];
		} catch {
			spellingErrors = [];
		}
		return {
			question_id: qid,
			dx_id: q?.dx_id ?? null,
			canonical_long: q?.canonical_long ?? null,
			topic: q?.topic ?? null,
			typed,
			tier: a?.tier ?? "miss",
			score: a?.score ?? 0,
			spelling_errors: spellingErrors,
		};
	});

	return c.json({
		score,
		max_score: maxScore,
		spelling_ok: spellingOk,
		lay_count: layCount,
		question_count: questionIds.length,
		breakdown,
	});
});

// ---------------------------------------------------------------------------
// GET /api/smear/wrong —— 按診斷聚合的錯題本
//
// 「錯」的判準是 tier != 'full'(half/lay/miss 都算)——設計的框架是「還沒
// 完全拿下的診斷」,不是只算完全猜錯的那種。wrong_count 數的是作答事件
// (跨所有場次),不是去重過的題目數 —— 同一診斷答錯愈多次,愈該排在前面。
//
// ⚠️ 一定要排掉「還沒 finish 的全真模式」session —— 這張表帶著 canonical_long
// (診斷全名),而全真模式的判定要到 /finish 才能揭曉。少了這個條件,使用者在
// 考試中途只要答錯一題,馬上打這支端點就能看到正解,完全繞過 GET /sessions/:id
// 那道 my_tier/my_score 閘。
// ---------------------------------------------------------------------------
smearRoutes.get("/wrong", async (c) => {
	const email = c.var.email;
	const { results } = await c.env.DB.prepare(
		`SELECT sd.id AS dx_id, sd.canonical_long, sd.topic,
            COUNT(*) AS wrong_count, MAX(sa.answered_at) AS last_wrong_at
       FROM smear_answers sa
       JOIN smear_sessions ss ON ss.id = sa.session_id AND ss.user_email = ?
       JOIN smear_questions sq ON sq.id = sa.question_id
       JOIN smear_dx sd ON sd.id = sq.dx_id
      WHERE sa.tier IS NOT NULL AND sa.tier != 'full'
        AND (ss.mode = 'review' OR ss.finished_at IS NOT NULL)
      GROUP BY sd.id
      ORDER BY wrong_count DESC, last_wrong_at DESC`,
	)
		.bind(email)
		.all<{
			dx_id: string;
			canonical_long: string;
			topic: string;
			wrong_count: number;
			last_wrong_at: number | null;
		}>();
	return c.json({ items: results ?? [] });
});

// ---------------------------------------------------------------------------
// GET /api/smear/topic-stats —— 首頁「複習模式選擇主題」頁的整體正確率 +
// 上次練習時間,按主題聚合。同 /wrong 的 join 路徑(smear_answers →
// smear_questions → smear_dx),差別只在**不篩 tier**(這裡要的是整體
// 表現,不是只看答錯的)、GROUP BY 換成 topic,並多算一個 MAX(answered_at)。
//
// 同樣要排掉未 finish 的全真模式(見 /wrong 的安全性註解)—— 少了這道
// WHERE,考試中途答一題就能從這支端點反推出「這題我對還是錯」,繞過
// GET /sessions/:id 的 revealGrade 閘。
// ---------------------------------------------------------------------------
smearRoutes.get("/topic-stats", async (c) => {
	const email = c.var.email;
	const { results } = await c.env.DB.prepare(
		`SELECT sd.topic AS topic,
            SUM(sa.score) AS score,
            COUNT(*) AS attempts,
            MAX(sa.answered_at) AS last_answered_at
       FROM smear_answers sa
       JOIN smear_sessions ss ON ss.id = sa.session_id AND ss.user_email = ?
       JOIN smear_questions sq ON sq.id = sa.question_id
       JOIN smear_dx sd ON sd.id = sq.dx_id
      WHERE (ss.mode = 'review' OR ss.finished_at IS NOT NULL)
      GROUP BY sd.topic`,
	)
		.bind(email)
		.all<{
			topic: string;
			score: number;
			attempts: number;
			last_answered_at: number | null;
		}>();
	return c.json({ items: results ?? [] });
});

// ---------------------------------------------------------------------------
// GET /api/smear/dx/:id —— 診斷詳情:詳解 + 所有圖 + accepted terms
// ---------------------------------------------------------------------------
smearRoutes.get("/dx/:id", async (c) => {
	const dxId = c.req.param("id");

	const dx = await c.env.DB.prepare("SELECT * FROM smear_dx WHERE id = ?")
		.bind(dxId)
		.first<Record<string, unknown>>();
	if (!dx) return c.json({ error: "not found" }, 404);

	const note = await c.env.DB.prepare(
		"SELECT * FROM smear_dx_notes WHERE dx_id = ?",
	)
		.bind(dxId)
		.first<{
			dx_id: string;
			content_json: string;
			related_dx_ids: string | null;
			version: number;
			updated_by: string | null;
			updated_at: number;
		}>();

	const { results: termRows } = await c.env.DB.prepare(
		`SELECT id, text, tier, form FROM smear_terms
       WHERE dx_id = ? AND status = 'accepted'
       ORDER BY tier ASC, form ASC, text ASC`,
	)
		.bind(dxId)
		.all<{ id: string; text: string; tier: string; form: string }>();

	const { results: questionRows } = await c.env.DB.prepare(
		`SELECT id, source, source_ref, source_url, attribution,
              image_key_view, image_key_full, prompt, image_note
       FROM smear_questions WHERE dx_id = ? ORDER BY created_at ASC`,
	)
		.bind(dxId)
		.all<Record<string, unknown>>();

	let related: { dx_id: string; canonical_long: string }[] = [];
	if (note?.related_dx_ids) {
		let ids: string[] = [];
		try {
			ids = (JSON.parse(note.related_dx_ids) as string[]).filter(
				(x) => typeof x === "string" && x !== dxId,
			);
		} catch {
			ids = [];
		}
		if (ids.length > 0) {
			const placeholders = ids.map(() => "?").join(",");
			const { results } = await c.env.DB.prepare(
				`SELECT id AS dx_id, canonical_long FROM smear_dx WHERE id IN (${placeholders})`,
			)
				.bind(...ids)
				.all<{ dx_id: string; canonical_long: string }>();
			related = results ?? [];
		}
	}

	// content_json 原樣以字串回傳,不在伺服器端 JSON.parse —— 跟 /api/questions/:id
	// 的 explanation 欄位同一個慣例,前端自己餵給 TipTap。
	return c.json({
		...dx,
		note: note ?? null,
		terms: termRows ?? [],
		questions: questionRows ?? [],
		related,
	});
});

// ---------------------------------------------------------------------------
// GET /api/smear/search?q= —— 獨立索引,重用 lib/fts-query.ts 的語法規則
// ---------------------------------------------------------------------------
smearRoutes.get("/search", async (c) => {
	const q = (c.req.query("q") || "").trim();
	if (!q) return c.json({ items: [], q });

	const match = ftsQuery(q);
	if (!match) return c.json({ items: [], q });

	try {
		const { results } = await c.env.DB.prepare(
			`SELECT f.dx_id, sd.canonical_long, sd.topic, sd.qtype
         FROM smear_fts f JOIN smear_dx sd ON sd.id = f.dx_id
        WHERE smear_fts MATCH ?
        ORDER BY bm25(smear_fts) ASC
        LIMIT 30`,
		)
			.bind(match)
			.all<{ dx_id: string; canonical_long: string; topic: string; qtype: string }>();
		return c.json({ items: results ?? [], q });
	} catch (e) {
		console.warn("smear search failed:", String(e));
		return c.json({ error: "search failed", q }, 400);
	}
});

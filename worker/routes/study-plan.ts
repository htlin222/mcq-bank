import { Hono } from "hono";
import type { Context } from "hono";
import type { AppContext, Env } from "../types";
import { todayInTaipei } from "../lib/activity.ts";
import { contentDisposition } from "../lib/export-doc.ts";
import { TEXT_MODEL } from "../lib/ai-models.ts";
import {
	buildPlan,
	parsePlanInput,
	type PlanContext,
	type YearStat,
} from "../lib/study-plan.ts";
import { renderPlanHtml } from "../lib/study-plan-html.ts";
import { renderPlanIcs } from "../lib/study-plan-ics.ts";

// 讀書計畫產生器。設計:docs/plans/2026-08-07-study-plan-generator-design.md
//
// PRIVACY: 每一個查詢都綁 c.var.email,不接受 email 參數,也不回任何跨使用者
// 的比較數字。
//
// 排程本身是 worker/lib/study-plan.ts 的純函式 —— 這裡只負責把 D1 的進度撈成
// PlanContext、把 client 的問卷答案 clamp 成 PlanInput,以及決定回 JSON 還是
// 回檔案。前端不重算排程,兩邊各算一次必然會在某個邊界條件上算出不同數字。

export const studyPlanRoutes = new Hono<AppContext>();

/** 沒有作答紀錄時,問卷第 4 題(每題平均秒數)的預設值。 */
const FALLBACK_SECONDS = 90;

/** AI 弱點導讀的上限。逾時或失敗一律整段省略,計畫表照出。 */
const COACHING_TIMEOUT_MS = 6_000;
const COACHING_MAX_CHARS = 400;

type YearRow = { year: number; total: number };
type CountRow = { year: number; n: number };
type AccRow = { year: number; n: number; correct: number };

async function loadYears(
	db: Env["DB"],
	email: string,
): Promise<YearStat[]> {
	const [totals, done, acc] = await Promise.all([
		db
			.prepare("SELECT year, COUNT(*) AS total FROM questions GROUP BY year")
			.all<YearRow>(),
		// 與 /api/review/readiness 的「已完成」同一個定義(review_progress
		// 而非 attempts),兩處的數字才不會打架 —— attempts 自 0023 起才有,
		// 歷史未回填。
		db
			.prepare(
				`SELECT q.year AS year, COUNT(*) AS n
         FROM review_progress rp JOIN questions q ON q.id = rp.question_id
         WHERE rp.user_email = ? AND rp.times_seen > 0
         GROUP BY q.year`,
			)
			.bind(email)
			.all<CountRow>(),
		db
			.prepare(
				`SELECT q.year AS year, COUNT(*) AS n,
                SUM(CASE WHEN a.is_correct = 1 THEN 1 ELSE 0 END) AS correct
         FROM attempts a JOIN questions q ON q.id = a.question_id
         WHERE a.user_email = ? AND a.is_correct IS NOT NULL
         GROUP BY q.year`,
			)
			.bind(email)
			.all<AccRow>(),
	]);

	const doneBy = new Map((done.results ?? []).map((r) => [r.year, r.n]));
	const accBy = new Map(
		(acc.results ?? [])
			// 樣本太少的正確率不是正確率,是雜訊。寧可回 null 讓排程用預設值。
			.filter((r) => r.n >= 5)
			.map((r) => [r.year, r.correct / r.n]),
	);

	return (totals.results ?? [])
		.map((r) => ({
			year: r.year,
			total: r.total,
			completed: Math.min(doneBy.get(r.year) ?? 0, r.total),
			accuracy: accBy.get(r.year) ?? null,
		}))
		.sort((a, b) => b.year - a.year);
}

/** 每題耗時中位數(秒)。用 attempts 的實測值當問卷預設 —— 使用者通常高估
 *  自己的速度,這個數字就是把高估攤開來給他看。 */
async function medianSeconds(
	db: Env["DB"],
	email: string,
): Promise<number> {
	const { results } = await db
		.prepare(
			`SELECT elapsed_ms FROM attempts
       WHERE user_email = ? AND elapsed_ms IS NOT NULL AND elapsed_ms > 0
       ORDER BY created_at DESC LIMIT 500`,
		)
		.bind(email)
		.all<{ elapsed_ms: number }>();

	const xs = (results ?? []).map((r) => r.elapsed_ms).sort((a, b) => a - b);
	if (xs.length === 0) return FALLBACK_SECONDS;
	const mid = xs[Math.floor(xs.length / 2)];
	return Math.min(Math.max(Math.round(mid / 1000), 10), 600);
}

type TopicRow = { label: string; n: number; correct: number };

/** 弱點主題。刻意不用 /api/review/weakness-map —— 它依賴 Vectorize 索引,
 *  未回填時回空陣列,拿來當計畫的基礎會在多數使用者身上開天窗。
 *
 *  tag 走 tag_topics/video_topics 的白名單:question_tags 的 853 個自由標籤
 *  直接 group by 會得到一堆噪音(策展影片踩過這個坑)。作答數 < 8 的主題也
 *  濾掉 —— 「1 題錯 1 題 = 0%」是統計雜訊,不是弱點。 */
async function loadTopics(
	db: Env["DB"],
	email: string,
): Promise<TopicRow[]> {
	try {
		const { results } = await db
			.prepare(
				`SELECT vt.label AS label, COUNT(*) AS n,
                SUM(CASE WHEN a.is_correct = 1 THEN 1 ELSE 0 END) AS correct
         FROM attempts a
         JOIN question_tags qt ON qt.question_id = a.question_id
         JOIN tag_topics tt    ON tt.tag = qt.tag
         JOIN video_topics vt  ON vt.slug = tt.topic_slug
         WHERE a.user_email = ? AND a.is_correct IS NOT NULL
         GROUP BY vt.slug
         HAVING n >= 8
         ORDER BY (CAST(correct AS REAL) / n) ASC
         LIMIT 12`,
			)
			.bind(email)
			.all<TopicRow>();
		return results ?? [];
	} catch {
		// 影片主題表是後來的 migration;沒有它就沒有弱點導讀,不是錯誤。
		return [];
	}
}

/** AI 只負責把弱點寫成人話,不負責任何一個數字。送出去的只有一張彙總表,
 *  不含題目內容、不含 email。失敗 / 逾時 → null,計畫表照出。 */
async function coach(
	c: Context<AppContext>,
	topics: TopicRow[],
	daysLeft: number,
): Promise<string | null> {
	if (topics.length === 0) return null;

	const table = topics
		.map(
			(t) =>
				`${t.label}: 正確率 ${Math.round((t.correct / t.n) * 100)}%(作答 ${t.n} 題)`,
		)
		.join("\n");

	try {
		const out = await Promise.race([
			c.env.AI.run(TEXT_MODEL, {
				max_tokens: 400,
				temperature: 0.3,
				messages: [
					{
						role: "system",
						content:
							"你是血液腫瘤專科考試的讀書顧問。使用者會給你一張「主題 / 正確率 / 作答題數」的表。" +
							"請用繁體中文寫 3 到 4 句話:指出哪些主題是真正的弱點、建議先攻哪一個、" +
							"哪些只是作答題數少還不能下判斷。" +
							"嚴格限制:只能根據表上的數字,不可推論表上沒有的東西,不可編造題數或日期," +
							"不要寫鼓勵性的客套話,不要條列,不要重述整張表。",
					},
					{
						role: "user",
						content: `距離考試 ${daysLeft} 天。\n\n${table}`,
					},
				],
			}),
			new Promise<never>((_, reject) =>
				setTimeout(() => reject(new Error("timeout")), COACHING_TIMEOUT_MS),
			),
		]);
		const text = String((out as { response?: unknown }).response ?? "").trim();
		return text ? text.slice(0, COACHING_MAX_CHARS) : null;
	} catch {
		return null;
	}
}

function examDateOf(iso: string | undefined): string | null {
	const ms = iso ? Date.parse(iso) : NaN;
	if (!Number.isFinite(ms)) return null;
	return todayInTaipei(ms);
}

/** GET /api/study-plan — 對話要用的預填資料 + 上次的答案。 */
studyPlanRoutes.get("/", async (c) => {
	const email = c.var.email;
	const now = Date.now();

	const [years, seconds, saved] = await Promise.all([
		loadYears(c.env.DB, email),
		medianSeconds(c.env.DB, email),
		c.env.DB.prepare(
			"SELECT input_json, updated_at FROM study_plans WHERE user_email = ?",
		)
			.bind(email)
			.first<{ input_json: string; updated_at: number }>(),
	]);

	let savedInput: unknown = null;
	if (saved?.input_json) {
		try {
			savedInput = parsePlanInput(JSON.parse(saved.input_json));
		} catch {
			savedInput = null;
		}
	}

	return c.json({
		today: todayInTaipei(now),
		exam_date: examDateOf(c.env.EXAM_DATE_ISO),
		years,
		total: years.reduce((s, y) => s + y.total, 0),
		completed: years.reduce((s, y) => s + y.completed, 0),
		suggested_seconds: seconds,
		saved: savedInput,
		saved_at: saved?.updated_at ?? null,
	});
});

/** PUT /api/study-plan — 只存問卷答案,不存排程結果。 */
studyPlanRoutes.put("/", async (c) => {
	const input = parsePlanInput(await c.req.json().catch(() => null));
	const now = Date.now();
	await c.env.DB.prepare(
		`INSERT INTO study_plans (user_email, input_json, created_at, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_email) DO UPDATE SET input_json = excluded.input_json,
                                           updated_at = excluded.updated_at`,
	)
		.bind(c.var.email, JSON.stringify(input), now, now)
		.run();
	return c.json({ ok: true, input });
});

async function contextFor(
	c: Context<AppContext>,
): Promise<PlanContext | null> {
	const examDate = examDateOf(c.env.EXAM_DATE_ISO);
	if (!examDate) return null;
	return {
		today: todayInTaipei(Date.now()),
		examDate,
		years: await loadYears(c.env.DB, c.var.email),
	};
}

/** POST /api/study-plan/preview — dialog 即時預覽。改參數就重打。
 *  `want_coaching` 只在使用者走到預覽那一步時帶 true,不在每次改參數時燒神經元。 */
studyPlanRoutes.post("/preview", async (c) => {
	const body = (await c.req.json().catch(() => null)) as {
		input?: unknown;
		want_coaching?: boolean;
	} | null;

	const ctx = await contextFor(c);
	if (!ctx) return c.json({ error: "no_exam_date" }, 400);

	const input = parsePlanInput(body?.input);
	const plan = buildPlan(input, ctx);

	const coaching = body?.want_coaching
		? await coach(c, await loadTopics(c.env.DB, c.var.email), plan.days_left)
		: null;

	return c.json({ plan, coaching });
});

/** POST /api/study-plan/export?format=html|ics
 *
 *  coaching 由 client 帶回來(preview 已經產過一次),而不是這裡再打一次 AI ——
 *  同一份計畫燒兩次神經元、還可能拿到兩段不一樣的文字。內容一律經 escapeHtml,
 *  而且這份檔案只回給本人。 */
studyPlanRoutes.post("/export", async (c) => {
	const format = c.req.query("format") === "ics" ? "ics" : "html";
	const body = (await c.req.json().catch(() => null)) as {
		input?: unknown;
		coaching?: unknown;
	} | null;

	const ctx = await contextFor(c);
	if (!ctx) return c.json({ error: "no_exam_date" }, 400);

	const plan = buildPlan(parsePlanInput(body?.input), ctx);
	const stamp = ctx.today.replace(/-/g, "");

	if (format === "ics") {
		const ics = renderPlanIcs(plan, {
			email: c.var.email,
			now: Date.now(),
			host: c.env.PUBLIC_HOST || new URL(c.req.url).host,
		});
		return new Response(ics, {
			headers: {
				"content-type": "text/calendar; charset=utf-8",
				"content-disposition": contentDisposition(`讀書計畫-${stamp}.ics`),
			},
		});
	}

	const coaching =
		typeof body?.coaching === "string"
			? body.coaching.slice(0, COACHING_MAX_CHARS)
			: undefined;

	const html = renderPlanHtml(plan, {
		email: c.var.email,
		now: Date.now(),
		coaching,
	});
	return new Response(html, {
		headers: {
			"content-type": "text/html; charset=utf-8",
			"content-disposition": contentDisposition(`讀書計畫-${stamp}.html`),
		},
	});
});

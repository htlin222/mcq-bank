// 讀書計畫排程 —— 全部純函式,不碰 D1、不碰 Date.now()。
//
// 設計立場(見 docs/plans/2026-08-07-study-plan-generator-design.md):
//   * 這裡回答的是「我**打算**每天投入 90 分鐘、只寫這五年、想跑兩輪 ——
//     排得出來嗎」。輸入是意圖,不是歷史。`goal-pacing.ts` 回答的是另一題
//     (「以我目前的速度做得完嗎」),兩者刻意分開。
//   * **排不完就說排不完。** shortfall 帶著差額回傳,不靠縮小字級或樂觀排版
//     把它藏掉 —— 那句話是使用者現在就該做決定的唯一理由。
//   * 第二輪起只排錯題。若每輪都排全題,「剩 28 天跑兩輪 1000 題」會算出
//     一天 71 題,那不是計畫,是一張看一眼就關掉的表。
//   * Workers AI 不參與這裡的任何一個數字。LLM 做加法會錯,而錯的計畫表比
//     沒有計畫表更糟。
//
// 時區約定:與 goal-pacing.ts 相同 —— 所有 'YYYY-MM-DD' 進來之前就已經是
// UTC+8(Asia/Taipei)的日子,本檔不做任何時區換算。

import { startOfWeek } from "./goal-pacing.ts";

const DAY_MS = 86_400_000;

/** 沒有作答紀錄時假設的正確率。0.65 → 錯誤率 0.35。 */
export const DEFAULT_ACCURACY = 0.65;

export type YearStat = {
	year: number;
	/** 該年題數。 */
	total: number;
	/** 該年已完成題數。 */
	completed: number;
	/** 0..1;null = 沒有作答紀錄,改用 DEFAULT_ACCURACY。 */
	accuracy: number | null;
};

export type PlanInput = {
	/** 要寫的年份;空陣列 = 什麼都不排(需求 0,不是排不完)。 */
	years: number[];
	/** 使用者手動覆寫的「已完成總題數」;null = 以系統紀錄為準。 */
	completedOverride: number | null;
	minutesPerDay: number;
	secondsPerQuestion: number;
	/** 1..3。 */
	rounds: number;
	mockExams: number;
	restSunday: boolean;
	/** 'HH:MM',只給 .ics 用,排程本身不看。 */
	studyStart: string;
	studyEnd: string;
};

export type PlanContext = {
	/** 'YYYY-MM-DD',UTC+8 的今天。 */
	today: string;
	/** 'YYYY-MM-DD' 考試日。 */
	examDate: string;
	years: YearStat[];
};

export type Slice = {
	year: number;
	/** 1 = 第一輪(新題),>= 2 = 錯題輪。 */
	round: number;
	n: number;
	/** 該年題目清單中的 1-based **序位**區間(不是題號 —— 114 年的
	 *  `questions.number` 與 id 尾碼有已知錯位)。錯題輪無區間可指,為 null。 */
	from: number | null;
	to: number | null;
};

export type DayKind = "study" | "mock" | "rest" | "exam";

export type DayPlan = {
	date: string;
	kind: DayKind;
	count: number;
	slices: Slice[];
	label: string;
};

export type WeekPlan = {
	week_start: string;
	days: DayPlan[];
	total: number;
};

export type Suggestion =
	| { kind: "more_per_day"; extra_questions: number; extra_minutes: number }
	| { kind: "drop_year"; year: number; questions: number }
	| { kind: "fewer_rounds"; rounds: number };

export type PlanResult = {
	exam_date: string;
	/** 距考試天數,已 clamp 到 >= 0。 */
	days_left: number;
	/** 每日題數上限。 */
	daily_capacity: number;
	/** 實際可讀日數(扣掉休息日與模擬考日)。 */
	available_days: number;
	demand: number;
	demand_by_round: number[];
	scheduled: number;
	/** demand - scheduled,>= 0。這是整份結果最重要的一個數字。 */
	shortfall: number;
	weeks: WeekPlan[];
	mock_dates: string[];
	suggestions: Suggestion[];
	study_start: string;
	study_end: string;
};

function toInt(v: unknown, fallback = 0): number {
	const n = typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : NaN;
	return Number.isFinite(n) ? n : fallback;
}

function addDays(day: string, n: number): string {
	return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS)
		.toISOString()
		.slice(0, 10);
}

function diffDays(from: string, to: string): number {
	return Math.round(
		(Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS,
	);
}

function isSunday(day: string): boolean {
	return new Date(Date.parse(`${day}T00:00:00Z`)).getUTCDay() === 0;
}

/** 每日題數上限。除不盡無條件捨去 —— 寧可少排一題,也不要排一題做不完的。 */
export function dailyCapacity(
	minutesPerDay: number,
	secondsPerQuestion: number,
): number {
	const mins = Math.max(toInt(minutesPerDay), 0);
	const secs = Math.max(toInt(secondsPerQuestion), 0);
	if (mins === 0 || secs === 0) return 0;
	return Math.floor((mins * 60) / secs);
}

/** 把覆寫的「已完成總題數」等比攤回各年。餘數逐一補給前面的年份,
 *  保證各年加總剛好等於覆寫值。 */
function applyOverride(years: YearStat[], override: number | null): YearStat[] {
	if (override == null) return years;
	const totalAll = years.reduce((s, y) => s + Math.max(y.total, 0), 0);
	if (totalAll === 0) return years;
	const target = Math.min(Math.max(toInt(override), 0), totalAll);

	const shares = years.map((y) => (Math.max(y.total, 0) * target) / totalAll);
	const floors = shares.map((s) => Math.floor(s));
	let rest = target - floors.reduce((s, n) => s + n, 0);
	const out = years.map((y, i) => {
		let c = floors[i];
		if (rest > 0 && c < y.total) {
			c += 1;
			rest -= 1;
		}
		return { ...y, completed: Math.min(c, y.total) };
	});
	return out;
}

/** 模擬考日期:自考試日往回,每 7 天一場。落在可讀視窗外的直接不排 ——
 *  硬塞進視窗會擠成連續好幾天考試,那不是模擬,是消耗。 */
function mockDates(
	examDate: string,
	windowStart: string,
	windowEnd: string,
	count: number,
): string[] {
	const out: string[] = [];
	for (let k = 1; k <= Math.max(toInt(count), 0); k++) {
		const d = addDays(examDate, -7 * k);
		if (d >= windowStart && d <= windowEnd) out.push(d);
	}
	return out.sort();
}

type QueueItem = { year: number; round: number; n: number; cursor: number | null };

/** 需求佇列:第一輪逐年(新年份先)的未完成題,之後每輪的錯題。
 *  順序即是使用者的讀書順序。 */
function buildQueue(
	years: YearStat[],
	selected: number[],
	rounds: number,
): { queue: QueueItem[]; byRound: number[] } {
	const picked = years
		.filter((y) => selected.includes(y.year))
		.sort((a, b) => b.year - a.year);

	const queue: QueueItem[] = [];
	const byRound: number[] = [];

	for (const y of picked) {
		const remaining = Math.max(y.total - y.completed, 0);
		if (remaining > 0) {
			queue.push({
				year: y.year,
				round: 1,
				n: remaining,
				cursor: y.completed + 1,
			});
		}
	}
	byRound.push(
		picked.reduce((s, y) => s + Math.max(y.total - y.completed, 0), 0),
	);

	for (let r = 2; r <= Math.max(toInt(rounds), 1); r++) {
		let sum = 0;
		for (const y of picked) {
			const wrongRate = 1 - (y.accuracy ?? DEFAULT_ACCURACY);
			const n = Math.round(y.total * Math.pow(wrongRate, r - 1));
			sum += n;
			if (n > 0) queue.push({ year: y.year, round: r, n, cursor: null });
		}
		byRound.push(sum);
	}

	return { queue, byRound };
}

function sliceLabel(slices: Slice[]): string {
	return slices
		.map((s) =>
			s.from != null && s.to != null
				? `${s.year} 年第 ${s.from}–${s.to} 題`
				: `${s.year} 年錯題 ${s.n} 題`,
		)
		.join(" + ");
}

export function buildPlan(input: PlanInput, ctx: PlanContext): PlanResult {
	const capacity = dailyCapacity(input.minutesPerDay, input.secondsPerQuestion);
	const daysLeft = Math.max(diffDays(ctx.today, ctx.examDate), 0);

	// 可讀視窗 = 明天 ~ 考試前一天。今天不算 —— 計畫是在今天產生的,
	// 今天的時間已經花掉一部分了。
	const windowStart = addDays(ctx.today, 1);
	const windowEnd = addDays(ctx.examDate, -1);

	const mocks =
		windowStart <= windowEnd
			? mockDates(ctx.examDate, windowStart, windowEnd, input.mockExams)
			: [];
	const mockSet = new Set(mocks);

	// 日曆骨架。休息日與模擬考日照樣列出來 —— 計畫表要看得到整段日子,
	// 空白的那幾天本身就是資訊。
	const skeleton: DayPlan[] = [];
	for (let d = windowStart; d <= windowEnd; d = addDays(d, 1)) {
		const kind: DayKind = mockSet.has(d)
			? "mock"
			: input.restSunday && isSunday(d)
				? "rest"
				: "study";
		skeleton.push({
			date: d,
			kind,
			count: 0,
			slices: [],
			label: kind === "mock" ? "全真模擬 · 100 題" : kind === "rest" ? "休息" : "",
		});
	}
	skeleton.push({
		date: ctx.examDate,
		kind: "exam",
		count: 0,
		slices: [],
		label: "考試日",
	});

	const studyDays = skeleton.filter((d) => d.kind === "study");
	const availableDays = studyDays.length;

	const years = applyOverride(ctx.years, input.completedOverride);
	const { queue, byRound } = buildQueue(years, input.years, input.rounds);
	const demand = byRound.reduce((s, n) => s + n, 0);

	const scheduled = Math.min(demand, capacity * availableDays);
	const shortfall = demand - scheduled;

	// 平均攤到每一天,不前重後空。餘數補給前面的日子。
	const base = availableDays > 0 ? Math.floor(scheduled / availableDays) : 0;
	let extra = availableDays > 0 ? scheduled % availableDays : 0;

	let qi = 0;
	for (const day of studyDays) {
		let want = base + (extra > 0 ? 1 : 0);
		if (extra > 0) extra -= 1;
		while (want > 0 && qi < queue.length) {
			const item = queue[qi];
			const take = Math.min(want, item.n);
			const from = item.cursor;
			day.slices.push({
				year: item.year,
				round: item.round,
				n: take,
				from,
				to: from == null ? null : from + take - 1,
			});
			day.count += take;
			want -= take;
			item.n -= take;
			if (item.cursor != null) item.cursor += take;
			if (item.n === 0) qi += 1;
		}
		day.label = sliceLabel(day.slices);
	}

	const suggestions = suggest({
		shortfall,
		availableDays,
		secondsPerQuestion: input.secondsPerQuestion,
		years,
		selected: input.years,
		rounds: input.rounds,
	});

	// 週分組:週一起算,與 goal-pacing 的 startOfWeek 同一套定義。
	const weeks: WeekPlan[] = [];
	for (const day of skeleton) {
		const ws = startOfWeek(day.date);
		let w = weeks.at(-1);
		if (!w || w.week_start !== ws) {
			w = { week_start: ws, days: [], total: 0 };
			weeks.push(w);
		}
		w.days.push(day);
		w.total += day.count;
	}

	return {
		exam_date: ctx.examDate,
		days_left: daysLeft,
		daily_capacity: capacity,
		available_days: availableDays,
		demand,
		demand_by_round: byRound,
		scheduled,
		shortfall,
		weeks,
		mock_dates: mocks,
		suggestions,
		study_start: input.studyStart,
		study_end: input.studyEnd,
	};
}

/** 排不完時給的三條路。順序即建議順序:先加時間,不行才砍範圍,最後才減輪次
 *  —— 減輪次的學習成本最高(第二輪的錯題複習是這份計畫裡效益最好的部分)。 */
function suggest(args: {
	shortfall: number;
	availableDays: number;
	secondsPerQuestion: number;
	years: YearStat[];
	selected: number[];
	rounds: number;
}): Suggestion[] {
	if (args.shortfall <= 0) return [];
	const out: Suggestion[] = [];

	if (args.availableDays > 0) {
		const extraQ = Math.ceil(args.shortfall / args.availableDays);
		out.push({
			kind: "more_per_day",
			extra_questions: extraQ,
			extra_minutes: Math.ceil((extraQ * args.secondsPerQuestion) / 60),
		});
	}

	// 砍最舊的一年 —— 考題與臨床實務的距離隨年份遞增,舊年份的邊際效益最低。
	const picked = args.years
		.filter((y) => args.selected.includes(y.year))
		.sort((a, b) => a.year - b.year);
	if (picked.length > 1) {
		const oldest = picked[0];
		const wrongRate = 1 - (oldest.accuracy ?? DEFAULT_ACCURACY);
		let q = Math.max(oldest.total - oldest.completed, 0);
		for (let r = 2; r <= Math.max(toInt(args.rounds), 1); r++) {
			q += Math.round(oldest.total * Math.pow(wrongRate, r - 1));
		}
		out.push({ kind: "drop_year", year: oldest.year, questions: q });
	}

	if (args.rounds > 1) {
		out.push({ kind: "fewer_rounds", rounds: args.rounds - 1 });
	}

	return out;
}

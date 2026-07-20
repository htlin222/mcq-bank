// 讀書進度預估(每週目標 + 考前完成預估)— 全部純函式,不碰 D1、不碰 Date.now()。
//
// 命名說明:`worker/lib/pacing.ts` 已經被「每題作答配速統計」佔用(median /
// percentile / pacingSplit,服務單題耗時)。那是另一個語意領域,硬塞進去只會
// 讓兩組不相干的東西共用一個檔名。這裡另開 goal-pacing.ts。
//
// 設計立場(見 docs/plans/2026-07-20-study-goals-and-pacing.md):
//   * 做「每週目標」,不做 daily streak。漏一天就歸零對成年在職考生(值班、
//     家庭、突發)是棄坑觸發器而非動力。每週目標保留「週三沒讀、週六補回來」
//     的補救空間,同時仍服務 distributed practice。
//   * 不做排行榜、積分、徽章。20 人熟人圈,公開排名對落後的人是壓力、對領先
//     的人是噪音,而且誘導「刷題數」而非「讀懂」。所有數字只有自己看得到。
//   * 落後時的輸出是「每天 N 題就能追上」(needed_per_day),不是「你落後了」。
//
// 時區約定:本檔完全不做時區換算。所有 'YYYY-MM-DD' 字串在進來之前就已經是
// UTC+8(Asia/Taipei)的日子(見 worker/lib/activity.ts 的 todayInTaipei 與
// SQL 的 '+8 hours' 修飾子)。

export type DayCount = { d: string; n: number };

export type PacingInput = {
	/** 近 N 天的每日完成題數(可有缺日、可含視窗外的日子)。 */
	daily: DayCount[];
	/** 'YYYY-MM-DD',UTC+8 的今天。 */
	today: string;
	totalQuestions: number;
	completed: number;
	/** 距考試天數;null = 未設考試日(EXAM_DATE_ISO 未設)。 */
	daysLeft: number | null;
	weeklyTarget: number;
};

export type Pacing = {
	total_questions: number;
	completed: number;
	remaining: number;
	done: boolean;
	/** 考試日已過時 clamp 到 0;未設考試日為 null。 */
	days_left: number | null;
	/** 近 7 天(含今天)平均題/天,分母固定 7,取小數 1 位。 */
	recent_rate: number;
	/** 依 recent_rate 還需幾天跑完;速度 0 時 null(不是 Infinity)。 */
	days_to_finish: number | null;
	/** days_left - days_to_finish;任一為 null 時 null。 */
	buffer_days: number | null;
	/** 考前跑得完嗎;未設考試日時 null。 */
	on_track: boolean | null;
	/** 要在考前跑完,每天需要幾題;未設考試日時 null。 */
	needed_per_day: number | null;
	/** 本週(週一起算,UTC+8)的起始日 'YYYY-MM-DD'。 */
	week_start: string;
	week_done: number;
	week_target: number;
	/** 0..100+,四捨五入到整數。target <= 0 時為 0。 */
	week_pct: number;
	week_met: boolean;
};

const DAY_MS = 86_400_000;

/** 一週 = 週一 00:00 (UTC+8) 起。輸入已是 UTC+8 的日期字串,故純 UTC 運算。 */
export function startOfWeek(day: string): string {
	const t = Date.parse(`${day}T00:00:00Z`);
	const dow = new Date(t).getUTCDay(); // 0 = 週日
	const offset = (dow + 6) % 7; // 週一 → 0,週日 → 6
	return new Date(t - offset * DAY_MS).toISOString().slice(0, 10);
}

/** 從 day 往回推 n 天的日期字串(n 為正數)。 */
function minusDays(day: string, n: number): string {
	return new Date(Date.parse(`${day}T00:00:00Z`) - n * DAY_MS)
		.toISOString()
		.slice(0, 10);
}

/** 建議每週目標:把剩餘題數攤平到剩餘週數,四捨五入到最近的 10,
 *  clamp 到 [10, 300]。上限就是為了不給出羞辱性的數字 —— 這是資訊,
 *  不是強制,使用者隨時可覆寫。 */
export function suggestWeeklyTarget(
	remaining: number,
	daysLeft: number | null,
): number {
	const days = Math.max(daysLeft ?? 90, 1);
	const weeks = days / 7;
	const raw = Math.max(remaining, 0) / weeks;
	const rounded = Math.round(raw / 10) * 10;
	return Math.min(300, Math.max(10, rounded));
}

export function computePacing(input: PacingInput): Pacing {
	const totalQuestions = Math.max(input.totalQuestions | 0, 0);
	const completed = Math.max(input.completed | 0, 0);
	const remaining = Math.max(totalQuestions - completed, 0);
	const done = remaining === 0;

	// 考試日已過 → clamp 到 0,而不是讓負數往下游傳。
	const daysLeft = input.daysLeft == null ? null : Math.max(input.daysLeft, 0);

	// 近 7 天(含今天)。分母固定 7,不用「有活動的天數」—— 否則久沒讀反而
	// 顯示高速度,是最糟糕的失真方向。
	const windowStart = minusDays(input.today, 6);
	let recentSum = 0;
	let weekSum = 0;
	const weekStart = startOfWeek(input.today);
	for (const row of input.daily) {
		const n = Number(row.n) || 0;
		if (row.d >= windowStart && row.d <= input.today) recentSum += n;
		if (row.d >= weekStart && row.d <= input.today) weekSum += n;
	}
	const recentRate = Math.round((recentSum / 7) * 10) / 10;

	const daysToFinish = done
		? 0
		: recentRate > 0
			? Math.ceil(remaining / recentRate)
			: null;

	const bufferDays =
		daysLeft != null && daysToFinish != null ? daysLeft - daysToFinish : null;

	const neededPerDay =
		daysLeft == null ? null : Math.ceil(remaining / Math.max(daysLeft, 1));

	const onTrack =
		daysLeft == null
			? null
			: done || (daysToFinish != null && daysToFinish <= daysLeft);

	const weekTarget = Math.max(input.weeklyTarget | 0, 0);
	const weekPct =
		weekTarget > 0 ? Math.round((weekSum / weekTarget) * 100) : 0;

	return {
		total_questions: totalQuestions,
		completed,
		remaining,
		done,
		days_left: daysLeft,
		recent_rate: recentRate,
		days_to_finish: daysToFinish,
		buffer_days: bufferDays,
		on_track: onTrack,
		needed_per_day: neededPerDay,
		week_start: weekStart,
		week_done: weekSum,
		week_target: weekTarget,
		week_pct: weekPct,
		// `>=` 而不是 `>`:剛好做滿目標就是達標。
		week_met: weekTarget > 0 && weekSum >= weekTarget,
	};
}

import { test } from "node:test";
import assert from "node:assert/strict";
import {
	buildPlan,
	dailyCapacity,
	parsePlanInput,
	type PlanContext,
	type PlanInput,
} from "./study-plan.ts";

// 2026-08-08 (六) ~ 2026-09-04 (五) = 28 個可讀日;考試 2026-09-05 (六)。
// 期間週日:08-09 / 08-16 / 08-23 / 08-30 共 4 天。
// 模擬考落在 examDate - 7k:08-29 / 08-22 / 08-15 / 08-08(皆為週六)。
const CTX = (years: PlanContext["years"]): PlanContext => ({
	today: "2026-08-07",
	examDate: "2026-09-05",
	years,
});

const YEAR = (year: number, completed = 0, accuracy: number | null = 0.65) => ({
	year,
	total: 100,
	completed,
	accuracy,
});

const INPUT = (over: Partial<PlanInput> = {}): PlanInput => ({
	years: [114],
	completedOverride: null,
	minutesPerDay: 90,
	secondsPerQuestion: 90,
	rounds: 1,
	mockExams: 0,
	restSunday: false,
	studyStart: "21:00",
	studyEnd: "22:30",
	...over,
});

test("每日容量 = floor(分鐘 × 60 / 每題秒數)", () => {
	assert.equal(dailyCapacity(90, 90), 60);
	assert.equal(dailyCapacity(30, 90), 20);
	assert.equal(dailyCapacity(45, 90), 30);
	// 除不盡無條件捨去 —— 寧可少排一題也不要排一題做不完的。
	assert.equal(dailyCapacity(50, 90), 33);
	// 不可除以零、不可回 Infinity。
	assert.equal(dailyCapacity(90, 0), 0);
	assert.equal(dailyCapacity(0, 90), 0);
});

test("典型情境:題數平均攤到每一天,不前重後空", () => {
	const r = buildPlan(INPUT(), CTX([YEAR(114)]));

	assert.equal(r.daily_capacity, 60);
	assert.equal(r.available_days, 28);
	assert.equal(r.demand, 100);
	assert.equal(r.scheduled, 100);
	assert.equal(r.shortfall, 0);
	assert.deepEqual(r.suggestions, []);

	const days = r.weeks.flatMap((w) => w.days).filter((d) => d.kind === "study");
	assert.equal(days.length, 28);
	// 100 / 28 = 3 餘 16 → 前 16 天各 4 題,其餘各 3 題。沒有空手的一天。
	assert.equal(days.filter((d) => d.count === 4).length, 16);
	assert.equal(days.filter((d) => d.count === 3).length, 12);
	assert.equal(
		days.reduce((s, d) => s + d.count, 0),
		100,
	);
});

test("第一輪的切片是該年的序位區間,連續且不重疊", () => {
	const r = buildPlan(
		INPUT({ years: [114, 113], minutesPerDay: 30 }),
		CTX([YEAR(114, 40), YEAR(113, 0)]),
	);

	// 114 剩 60 題(序位 41-100)、113 剩 100 題(序位 1-100)。
	assert.equal(r.demand, 160);

	const slices = r.weeks
		.flatMap((w) => w.days)
		.flatMap((d) => d.slices)
		.filter((s) => s.round === 1);

	const of114 = slices.filter((s) => s.year === 114);
	assert.equal(of114[0].from, 41);
	assert.equal(of114[of114.length - 1].to, 100);
	assert.equal(
		of114.reduce((s, x) => s + x.n, 0),
		60,
	);
	// 新年份先寫完才輪到舊年份。
	const firstOf113 = slices.findIndex((s) => s.year === 113);
	assert.equal(
		slices.slice(0, firstOf113).every((s) => s.year === 114),
		true,
	);
	// 區間首尾相接,不重疊也不跳號。
	for (let i = 1; i < of114.length; i++) {
		assert.equal(of114[i].from, of114[i - 1].to! + 1);
	}
});

test("第二輪只排錯題,不是重跑全題", () => {
	const r = buildPlan(INPUT({ rounds: 2 }), CTX([YEAR(114, 0, 0.65)]));

	// 第一輪 100 題;第二輪 = 100 × (1 - 0.65) = 35 題,不是又一個 100。
	assert.deepEqual(r.demand_by_round, [100, 35]);
	assert.equal(r.demand, 135);

	// 第三輪再乘一次錯誤率:100 × 0.35² ≈ 12。
	const three = buildPlan(INPUT({ rounds: 3 }), CTX([YEAR(114, 0, 0.65)]));
	assert.deepEqual(three.demand_by_round, [100, 35, 12]);

	// 錯題沒有序位區間可指 —— from/to 必須是 null,不能瞎編。
	const r2 = r.weeks
		.flatMap((w) => w.days)
		.flatMap((d) => d.slices)
		.filter((s) => s.round === 2);
	assert.equal(r2.length > 0, true);
	assert.equal(
		r2.every((s) => s.from === null && s.to === null),
		true,
	);
});

test("沒有作答紀錄的年份用預設錯誤率 0.35", () => {
	const r = buildPlan(INPUT({ rounds: 2 }), CTX([YEAR(114, 0, null)]));
	assert.deepEqual(r.demand_by_round, [100, 35]);
});

test("週日留白:不排題,且題數攤到其餘天數", () => {
	const r = buildPlan(INPUT({ restSunday: true }), CTX([YEAR(114)]));

	assert.equal(r.available_days, 24); // 28 - 4 個週日
	const all = r.weeks.flatMap((w) => w.days);
	const sundays = all.filter((d) => d.date.match(/^2026-08-(09|16|23|30)$/));
	assert.equal(sundays.length, 4);
	assert.equal(
		sundays.every((d) => d.kind === "rest" && d.count === 0),
		true,
	);
	assert.equal(
		all.reduce((s, d) => s + d.count, 0),
		100,
	);
});

test("全真模擬獨佔整天,依週間隔往考前排", () => {
	const r = buildPlan(INPUT({ mockExams: 4 }), CTX([YEAR(114)]));

	assert.deepEqual(r.mock_dates, [
		"2026-08-08",
		"2026-08-15",
		"2026-08-22",
		"2026-08-29",
	]);
	assert.equal(r.available_days, 24); // 28 - 4 場模擬

	const all = r.weeks.flatMap((w) => w.days);
	const mocks = all.filter((d) => d.kind === "mock");
	assert.equal(mocks.length, 4);
	// 模擬考當天不排日常題目 —— 100 題本身就是一整天。
	assert.equal(
		mocks.every((d) => d.count === 0 && d.slices.length === 0),
		true,
	);
});

test("場次多到排不進視窗時,只留排得進去的", () => {
	// 視窗 28 天,間隔 7 天最多放得下 4 場(exam-7 … exam-28)。
	const r = buildPlan(INPUT({ mockExams: 6 }), CTX([YEAR(114)]));
	assert.equal(r.mock_dates.length, 4);
});

test("排不完就說排不完,並給三條可執行的路", () => {
	const years = [114, 113, 112, 111, 110].map((y) => YEAR(y));
	const r = buildPlan(
		INPUT({
			years: [114, 113, 112, 111, 110],
			rounds: 2,
			mockExams: 4,
			restSunday: true,
			minutesPerDay: 30, // 容量 20 題/天
		}),
		CTX(years),
	);

	// 需求 500 + 175 = 675;可讀日 28 - 4 週日 - 4 模擬 = 20 天 × 20 題 = 400。
	assert.equal(r.demand, 675);
	assert.equal(r.available_days, 20);
	assert.equal(r.scheduled, 400);
	assert.equal(r.shortfall, 275);

	const kinds = r.suggestions.map((s) => s.kind);
	assert.deepEqual(kinds, ["more_per_day", "drop_year", "fewer_rounds"]);

	const more = r.suggestions.find((s) => s.kind === "more_per_day")!;
	assert.equal(more.extra_questions, 14); // ceil(275 / 20)
	assert.equal(more.extra_minutes, 21); // ceil(14 × 90 / 60)

	// 砍年份先砍最舊的那一年。
	const drop = r.suggestions.find((s) => s.kind === "drop_year")!;
	assert.equal(drop.year, 110);

	const fewer = r.suggestions.find((s) => s.kind === "fewer_rounds")!;
	assert.equal(fewer.rounds, 1);
});

test("只跑一輪時不建議「再少一輪」", () => {
	const r = buildPlan(
		INPUT({ years: [114, 113], rounds: 1, minutesPerDay: 30 }),
		CTX([YEAR(114), YEAR(113)]),
	);
	assert.equal(r.shortfall, 0);
	assert.deepEqual(r.suggestions, []);

	const tight = buildPlan(
		INPUT({ years: [114, 113], rounds: 1, minutesPerDay: 5 }),
		CTX([YEAR(114), YEAR(113)]),
	);
	assert.equal(tight.shortfall > 0, true);
	assert.deepEqual(
		tight.suggestions.map((s) => s.kind),
		["more_per_day", "drop_year"],
	);
});

test("考試日已過或就在明天:回空計畫,不進負數迴圈", () => {
	const past = buildPlan(INPUT(), {
		today: "2026-09-10",
		examDate: "2026-09-05",
		years: [YEAR(114)],
	});
	assert.equal(past.days_left, 0);
	assert.equal(past.available_days, 0);
	assert.equal(past.scheduled, 0);
	assert.equal(past.shortfall, 100);
	assert.deepEqual(past.weeks.flatMap((w) => w.days).filter((d) => d.kind === "study"), []);

	const tomorrow = buildPlan(INPUT(), {
		today: "2026-09-04",
		examDate: "2026-09-05",
		years: [YEAR(114)],
	});
	assert.equal(tomorrow.available_days, 0);
	assert.equal(tomorrow.shortfall, 100);
});

test("考試當天一定在表上,即使一題都排不進去", () => {
	const r = buildPlan(INPUT(), CTX([YEAR(114)]));
	const last = r.weeks.at(-1)!.days.at(-1)!;
	assert.equal(last.date, "2026-09-05");
	assert.equal(last.kind, "exam");
	assert.equal(last.count, 0);
});

test("進度覆寫依各年題數等比縮放,並夾在 [0, 總題數]", () => {
	const ctx = CTX([YEAR(114, 0), YEAR(113, 0)]);
	const r = buildPlan(
		INPUT({ years: [114, 113], completedOverride: 50 }),
		ctx,
	);
	assert.equal(r.demand, 150); // 200 - 50

	const slices = r.weeks
		.flatMap((w) => w.days)
		.flatMap((d) => d.slices)
		.filter((s) => s.year === 114);
	assert.equal(slices[0].from, 26); // 100 題中攤到 25 題已完成

	// 覆寫超過總題數 → 夾住,不產生負需求。
	const over = buildPlan(
		INPUT({ years: [114, 113], completedOverride: 9999 }),
		ctx,
	);
	assert.equal(over.demand, 0);
	assert.equal(over.shortfall, 0);
});

test("一年都沒選:需求 0,不當成排不完", () => {
	const r = buildPlan(INPUT({ years: [] }), CTX([YEAR(114)]));
	assert.equal(r.demand, 0);
	assert.equal(r.scheduled, 0);
	assert.equal(r.shortfall, 0);
	assert.deepEqual(r.suggestions, []);
});

test("週分組以週一為起點,每週 total 等於該週題數和", () => {
	const r = buildPlan(INPUT(), CTX([YEAR(114)]));
	assert.equal(r.weeks[0].week_start, "2026-08-03"); // 08-08 是週六
	for (const w of r.weeks) {
		assert.equal(
			w.total,
			w.days.reduce((s, d) => s + d.count, 0),
		);
	}
	// 每一天只出現一次,且日期遞增。
	const dates = r.weeks.flatMap((w) => w.days).map((d) => d.date);
	assert.deepEqual([...dates].sort(), dates);
	assert.equal(new Set(dates).size, dates.length);
});

test("parsePlanInput:垃圾輸入退回可用的預設值,不炸也不回 NaN", () => {
	const d = parsePlanInput(null);
	assert.deepEqual(d.years, []);
	assert.equal(d.completedOverride, null);
	assert.equal(Number.isFinite(d.minutesPerDay), true);
	assert.equal(Number.isFinite(d.secondsPerQuestion), true);
	assert.equal(d.rounds >= 1, true);
	assert.deepEqual(parsePlanInput("nope"), d);
	assert.deepEqual(parsePlanInput(42), d);
});

test("parsePlanInput:數值一律 clamp,不信任 client", () => {
	const big = parsePlanInput({
		minutesPerDay: 99999,
		secondsPerQuestion: 99999,
		rounds: 99,
		mockExams: 99,
	});
	assert.equal(big.minutesPerDay, 720);
	assert.equal(big.secondsPerQuestion, 600);
	assert.equal(big.rounds, 3);
	assert.equal(big.mockExams, 6);

	const small = parsePlanInput({
		minutesPerDay: -5,
		secondsPerQuestion: 0,
		rounds: 0,
		mockExams: -1,
		completedOverride: -20,
	});
	assert.equal(small.minutesPerDay, 5);
	assert.equal(small.secondsPerQuestion, 10);
	assert.equal(small.rounds, 1);
	assert.equal(small.mockExams, 0);
	assert.equal(small.completedOverride, 0);

	// 小數與字串數字都收斂成整數。
	const odd = parsePlanInput({ minutesPerDay: "90", rounds: 2.7 });
	assert.equal(odd.minutesPerDay, 90);
	assert.equal(odd.rounds, 2);
});

test("parsePlanInput:年份去重、去雜質、由新到舊", () => {
	const r = parsePlanInput({ years: [110, "113", 114, 114, null, 1.5, 113] });
	assert.deepEqual(r.years, [114, 113, 110]);
	assert.deepEqual(parsePlanInput({ years: "114" }).years, []);
});

test("parsePlanInput:時段格式不合就退回預設,不讓 25:99 進 .ics", () => {
	const ok = parsePlanInput({ studyStart: "07:05", studyEnd: "09:30" });
	assert.equal(ok.studyStart, "07:05");
	assert.equal(ok.studyEnd, "09:30");

	const bad = parsePlanInput({ studyStart: "25:99", studyEnd: "上午" });
	assert.equal(bad.studyStart, "21:00");
	assert.equal(bad.studyEnd, "22:30");
});

test("parsePlanInput:接得住自己吐出來的東西(round-trip)", () => {
	const once = parsePlanInput({
		years: [114, 113],
		completedOverride: 30,
		minutesPerDay: 45,
		secondsPerQuestion: 75,
		rounds: 2,
		mockExams: 3,
		restSunday: true,
		studyStart: "06:00",
		studyEnd: "07:15",
	});
	assert.deepEqual(parsePlanInput(JSON.parse(JSON.stringify(once))), once);
});

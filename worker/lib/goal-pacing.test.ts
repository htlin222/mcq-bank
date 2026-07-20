import { test } from "node:test";
import assert from "node:assert/strict";
import {
	computePacing,
	startOfWeek,
	suggestWeeklyTarget,
} from "./goal-pacing.ts";

const base = {
	totalQuestions: 1000,
	completed: 660,
	daysLeft: 41,
	weeklyTarget: 100,
};

test("週一為一週起點;週日屬於前一個週一", () => {
	assert.equal(startOfWeek("2026-07-20"), "2026-07-20"); // 週一
	assert.equal(startOfWeek("2026-07-19"), "2026-07-13"); // 週日 → 上週一
	assert.equal(startOfWeek("2026-07-22"), "2026-07-20");
	// 跨月 / 跨年邊界
	assert.equal(startOfWeek("2026-01-01"), "2025-12-29");
});

test("典型情境:本週進度、近 7 天速度、預估完成日與緩衝天數", () => {
	const daily = Array.from({ length: 7 }, (_, i) => ({
		d: `2026-07-${String(14 + i).padStart(2, "0")}`,
		n: 18,
	}));
	const r = computePacing({ ...base, daily, today: "2026-07-20" });
	assert.equal(r.recent_rate, 18);
	assert.equal(r.remaining, 340);
	assert.equal(r.days_to_finish, 19); // ceil(340 / 18)
	assert.equal(r.buffer_days, 22); // 41 - 19
	assert.equal(r.on_track, true);
	assert.equal(r.needed_per_day, 9); // ceil(340 / 41)
	assert.equal(r.days_left, 41);
	assert.equal(r.done, false);
});

test("零活動:不可除以零、不可回 Infinity", () => {
	const r = computePacing({ ...base, daily: [], today: "2026-07-20" });
	assert.equal(r.recent_rate, 0);
	assert.equal(r.days_to_finish, null); // 不是 Infinity
	assert.equal(r.buffer_days, null);
	assert.equal(r.on_track, false);
	assert.equal(Number.isFinite(r.needed_per_day), true);
	assert.equal(r.week_done, 0);
	assert.equal(r.week_pct, 0);
	assert.equal(r.week_met, false);
});

test("跨週邊界:上週日的題數不算進本週", () => {
	const daily = [
		{ d: "2026-07-19", n: 50 },
		{ d: "2026-07-20", n: 5 },
	];
	const r = computePacing({ ...base, daily, today: "2026-07-20" });
	assert.equal(r.week_done, 5);
	assert.equal(r.week_start, "2026-07-20");
});

test("已完成全部:remaining 0、needed_per_day 0、done/on_track true", () => {
	const r = computePacing({
		...base,
		completed: 1000,
		daily: [],
		today: "2026-07-20",
	});
	assert.equal(r.remaining, 0);
	assert.equal(r.needed_per_day, 0);
	assert.equal(r.days_to_finish, 0);
	assert.equal(r.done, true);
	assert.equal(r.on_track, true);
});

test("考試日已過:days_left clamp 到 0,needed_per_day 不得 Infinity", () => {
	const r = computePacing({
		...base,
		daysLeft: -3,
		daily: [],
		today: "2026-07-20",
	});
	assert.equal(r.days_left, 0);
	assert.equal(r.needed_per_day, 340); // ceil(340 / max(0,1))
	assert.equal(Number.isFinite(r.needed_per_day), true);
	assert.equal(r.on_track, false);
});

test("未設考試日:days_left / on_track / needed_per_day 皆 null,速度照常", () => {
	const daily = [{ d: "2026-07-20", n: 14 }];
	const r = computePacing({
		...base,
		daysLeft: null,
		daily,
		today: "2026-07-20",
	});
	assert.equal(r.days_left, null);
	assert.equal(r.on_track, null);
	assert.equal(r.needed_per_day, null);
	assert.equal(r.buffer_days, null);
	assert.equal(r.recent_rate, 2); // 14 / 7
	assert.equal(r.week_done, 14);
});

test("剛好達標:week_met 用 >= 不是 >", () => {
	const r = computePacing({
		...base,
		daily: [{ d: "2026-07-20", n: 100 }],
		today: "2026-07-20",
	});
	assert.equal(r.week_done, 100);
	assert.equal(r.week_pct, 100);
	assert.equal(r.week_met, true);
});

test("速度視窗只看 today 往回 7 天,久遠的高峰不算", () => {
	const daily = [
		{ d: "2026-06-01", n: 700 },
		{ d: "2026-07-20", n: 7 },
	];
	const r = computePacing({ ...base, daily, today: "2026-07-20" });
	assert.equal(r.recent_rate, 1); // 7 / 7,分母固定 7
});

test("recent_rate 取到小數 1 位,分母固定 7(不用有活動的天數)", () => {
	const daily = [{ d: "2026-07-20", n: 10 }];
	const r = computePacing({ ...base, daily, today: "2026-07-20" });
	assert.equal(r.recent_rate, 1.4); // 10 / 7 = 1.428…
	assert.equal(r.days_to_finish, 243); // ceil(340 / 1.4)
});

test("suggestWeeklyTarget:攤平後四捨五入到 10,clamp 到 [10, 300]", () => {
	assert.equal(suggestWeeklyTarget(340, 41), 60); // 340 / (41/7) = 58.0 → 60
	assert.equal(suggestWeeklyTarget(0, 41), 10); // 下限
	assert.equal(suggestWeeklyTarget(1000, 7), 300); // 上限,不給羞辱性數字
	assert.equal(suggestWeeklyTarget(340, 0), 300); // 天數 0 不得除以零
	assert.equal(suggestWeeklyTarget(340, null), 30); // null → 當 90 天
});

test("任何輸入都不產生 NaN / Infinity", () => {
	const cases = [
		{ totalQuestions: 0, completed: 0, daysLeft: 0, weeklyTarget: 0 },
		{ totalQuestions: 0, completed: 5, daysLeft: null, weeklyTarget: 0 },
		{ totalQuestions: 1000, completed: 0, daysLeft: -100, weeklyTarget: 1 },
	];
	for (const c of cases) {
		const r = computePacing({ ...c, daily: [], today: "2026-07-20" });
		for (const [k, v] of Object.entries(r)) {
			if (typeof v === "number") {
				assert.equal(Number.isFinite(v), true, `${k} = ${v}`);
			}
		}
	}
});

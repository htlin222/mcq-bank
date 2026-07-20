import { test } from "node:test";
import assert from "node:assert/strict";
import { dayWindow, isDueToday, DEFAULT_DAY_START_HOUR } from "./due-window.ts";
const T = (iso: string) => Date.parse(iso);

test("預設日界是台北凌晨 4 點", () => {
	assert.equal(DEFAULT_DAY_START_HOUR, 4);
	const w = dayWindow(T("2026-07-20T10:00:00+08:00"));
	assert.equal(w.dayStart, T("2026-07-20T04:00:00+08:00"));
	assert.equal(w.dayEnd, T("2026-07-21T04:00:00+08:00"));
	assert.equal(w.dayKey, "2026-07-20");
});

test("凌晨 2 點仍屬前一天(熬夜不跳號)", () => {
	assert.equal(dayWindow(T("2026-07-21T02:30:00+08:00")).dayKey, "2026-07-20");
});

test("剛好落在邊界 04:00:00.000 算新的一天", () => {
	assert.equal(dayWindow(T("2026-07-21T04:00:00+08:00")).dayKey, "2026-07-21");
});

test("dayStartHour 可覆寫為 0", () => {
	assert.equal(
		dayWindow(T("2026-07-21T02:30:00+08:00"), { dayStartHour: 0 }).dayKey,
		"2026-07-21",
	);
});

test("clampHour 擋掉非法值,退回預設", () => {
	const w = dayWindow(T("2026-07-20T10:00:00+08:00"), { dayStartHour: 99 });
	assert.equal(w.dayStart, T("2026-07-20T04:00:00+08:00"));
	const nan = dayWindow(T("2026-07-20T10:00:00+08:00"), { dayStartHour: NaN });
	assert.equal(nan.dayStart, T("2026-07-20T04:00:00+08:00"));
});

test("review 卡:今天稍晚到期算今天,未來卡不算", () => {
	const now = T("2026-07-20T10:00:00+08:00");
	const w = dayWindow(now);
	assert.equal(
		isDueToday({ due_at: T("2026-07-20T23:00:00+08:00"), state: 2 }, now, w),
		true,
	);
	assert.equal(
		isDueToday({ due_at: T("2026-07-22T09:00:00+08:00"), state: 2 }, now, w),
		false,
	);
});

test("learning 卡必須 due <= now", () => {
	const now = T("2026-07-20T10:00:00+08:00");
	const w = dayWindow(now);
	assert.equal(isDueToday({ due_at: now + 300_000, state: 1 }, now, w), false);
	assert.equal(isDueToday({ due_at: now - 300_000, state: 3 }, now, w), true);
});

test("從未複習過的新卡(無 row)永遠可做", () => {
	const now = T("2026-07-20T10:00:00+08:00");
	assert.equal(isDueToday(null, now, dayWindow(now)), true);
	assert.equal(
		isDueToday({ due_at: now + 86_400_000 * 30, state: 0 }, now, dayWindow(now)),
		true,
	);
});

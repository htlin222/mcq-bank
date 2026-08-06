import { test } from "node:test";
import assert from "node:assert/strict";
import {
	DEFAULT_SETTINGS,
	clampSettings,
	fmt,
	nextPhase,
	phaseMs,
} from "./pomodoro.ts";

const S = { ...DEFAULT_SETTINGS, longEvery: 4 };

test("專注結束 → 短休息,第 longEvery 輪才是長休息", () => {
	assert.deepEqual(nextPhase("focus", 0, S), { phase: "short", completedFocus: 1 });
	assert.deepEqual(nextPhase("focus", 2, S), { phase: "short", completedFocus: 3 });
	assert.deepEqual(nextPhase("focus", 3, S), { phase: "long", completedFocus: 4 });
	// 第二個週期同樣在第 8 輪拿到長休息
	assert.deepEqual(nextPhase("focus", 7, S), { phase: "long", completedFocus: 8 });
});

test("休息結束 → 回到專注,不動輪數", () => {
	assert.deepEqual(nextPhase("short", 3, S), { phase: "focus", completedFocus: 3 });
	assert.deepEqual(nextPhase("long", 4, S), { phase: "focus", completedFocus: 4 });
});

test("longEvery = 1 → 每輪都是長休息", () => {
	const s = { ...S, longEvery: 1 };
	assert.equal(nextPhase("focus", 0, s).phase, "long");
	assert.equal(nextPhase("focus", 1, s).phase, "long");
});

test("clampSettings 夾住越界值並保留合法值", () => {
	const c = clampSettings({
		focusMin: 999,
		shortMin: 0,
		longMin: 20,
		longEvery: -3,
		autoStart: true,
	});
	assert.equal(c.focusMin, 180);
	assert.equal(c.shortMin, 1);
	assert.equal(c.longMin, 20);
	assert.equal(c.longEvery, 1);
	assert.equal(c.autoStart, true);
	// 未提供的欄位回到預設
	assert.equal(c.sound, DEFAULT_SETTINGS.sound);
});

test("clampSettings 對垃圾輸入退回預設", () => {
	assert.deepEqual(clampSettings(null), DEFAULT_SETTINGS);
	assert.deepEqual(clampSettings({ focusMin: "abc" }), DEFAULT_SETTINGS);
	assert.equal(clampSettings({ focusMin: 25.6 }).focusMin, 26); // 四捨五入
});

test("phaseMs 依 phase 取對應分鐘數", () => {
	assert.equal(phaseMs("focus", S), 25 * 60_000);
	assert.equal(phaseMs("short", S), 5 * 60_000);
	assert.equal(phaseMs("long", S), 15 * 60_000);
});

test("fmt 無條件進位,負數歸零", () => {
	assert.equal(fmt(25 * 60_000), "25:00");
	assert.equal(fmt(59_001), "01:00"); // 進位,不會顯示 00:59
	assert.equal(fmt(1), "00:01");
	assert.equal(fmt(0), "00:00");
	assert.equal(fmt(-5000), "00:00");
	assert.equal(fmt(90 * 60_000), "90:00");
});

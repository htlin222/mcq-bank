import test from "node:test";
import assert from "node:assert/strict";
import {
	HIDDEN_YEARS,
	HIDDEN_YEAR_NOTE,
	isYearVisible,
	visibleYears,
	yearsToUnlock,
} from "./years.ts";

test("103 藏起來,其餘年份都看得到", () => {
	assert.equal(isYearVisible(103), false);
	for (const y of [104, 110, 113, 114, 115]) assert.equal(isYearVisible(y), true);
});

test("visibleYears 濾掉隱藏年份,順序與其餘欄位原樣保留", () => {
	const rows = [
		{ year: 114, count: 100 },
		{ year: 103, count: 42 },
		{ year: 113, count: 100 },
	];
	assert.deepEqual(visibleYears(rows), [
		{ year: 114, count: 100 },
		{ year: 113, count: 100 },
	]);
});

test("清單為空時不會炸", () => {
	assert.deepEqual(visibleYears([]), []);
});

// 這條是防呆:哪天有人把 103 從清單拿掉(例如題目補齊了),上面兩條會跟著紅,
// 提醒他一併看過「隱藏」這件事還需不需要存在。
test("目前只藏一個年份", () => {
	assert.equal(HIDDEN_YEARS.size, 1);
});

test("解鎖後 103 就看得到,而且沒解鎖的年份不受影響", () => {
	const rows = [
		{ year: 114, count: 100 },
		{ year: 103, count: 42 },
	];
	assert.deepEqual(visibleYears(rows, new Set([103])), rows);
	assert.equal(isYearVisible(103, new Set([103])), true);
	assert.equal(isYearVisible(103, new Set([115])), false, "解鎖別年不該連帶開 103");
});

test("每個隱藏年份都要有說明 —— 解鎖後卡片上要講得出為什麼", () => {
	// 少了說明的話,解鎖的人看到的就只是一個題數比較少的年份,沒有任何地方
	// 解釋那是資料不完整而不是那年真的只考 42 題。
	for (const y of HIDDEN_YEARS) {
		assert.equal(typeof HIDDEN_YEAR_NOTE[y], "string", `${y} 缺少說明`);
		assert.ok(HIDDEN_YEAR_NOTE[y].length > 0);
	}
});

test("yearsToUnlock 就是全部的隱藏年份", () => {
	assert.deepEqual(new Set(yearsToUnlock()), new Set(HIDDEN_YEARS));
});

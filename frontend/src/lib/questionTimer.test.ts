import { test } from "node:test";
import assert from "node:assert/strict";
import {
	MAX_QUESTION_MS,
	formatElapsed,
	hide,
	read,
	resume,
	show,
	startTimer,
} from "./questionTimer.ts";

// —— 給畫面看的格式 ————————————————————————————————————————

test("m:ss,秒數補零", () => {
	assert.equal(formatElapsed(0), "0:00");
	assert.equal(formatElapsed(9_000), "0:09");
	assert.equal(formatElapsed(65_000), "1:05");
	assert.equal(formatElapsed(600_000), "10:00");
});

test("不足一秒無條件捨去 —— 不要讓 0.9 秒顯示成 1 秒", () => {
	assert.equal(formatElapsed(999), "0:00");
	assert.equal(formatElapsed(1_999), "0:01");
});

test("負數夾到 0", () => {
	// ⚠️ 這是實際會發生的:換題時 timer 立刻重設成 startTimer(Date.now()),但畫面
	// 取樣用的 `now` 是每秒才更新的 state,兩者最多差一秒 —— read() 於是回一個
	// 小負數,直接格式化會顯示成「0:-1」。每換一題都會出現。
	assert.equal(formatElapsed(-1), "0:00");
	assert.equal(formatElapsed(-950), "0:00");
});

test("被截斷時顯示 10:00+,不是看起來像卡住的 10:00", () => {
	assert.equal(formatElapsed(MAX_QUESTION_MS, true), "10:00+");
	assert.equal(formatElapsed(MAX_QUESTION_MS, false), "10:00");
});

// —— 顯示值與記錄值是同一個來源 ————————————————————————————
//
// 這一組不是在重測 read(),是在釘住「畫面上那個數字」與「送進 attempts 的
// elapsed_ms」用同一條路徑算出來。分開算的話,使用者看到的與成績頁看到的會不一樣,
// 而那種不一致沒有人會想到要回報。

test("分頁隱藏的時間不算 —— 畫面上的數字也不該跳", () => {
	let t = startTimer(1000);
	t = hide(t, 3000); // 跑了 2 秒
	assert.equal(formatElapsed(read(t, 3000).elapsedMs), "0:02");
	// 隱藏期間過了一分鐘,數字不動。
	assert.equal(formatElapsed(read(t, 63_000).elapsedMs), "0:02");
	t = show(t, 63_000);
	assert.equal(formatElapsed(read(t, 64_000).elapsedMs), "0:03");
});

test("暫停期間不累計", () => {
	let t = startTimer(0);
	t = hide(t, 5_000);
	t = resume(t, 100_000);
	assert.equal(formatElapsed(read(t, 101_000).elapsedMs), "0:06");
});

test("超過上限時 read 會標 outlier,格式化跟著加上 +", () => {
	const t = startTimer(0);
	const r = read(t, MAX_QUESTION_MS + 60_000);
	assert.equal(r.outlier, true);
	assert.equal(formatElapsed(r.elapsedMs, r.outlier), "10:00+");
});

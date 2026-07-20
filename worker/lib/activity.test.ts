import { test } from "node:test";
import assert from "node:assert/strict";
import { todayInTaipei, TAIPEI_OFFSET_MS } from "./activity.ts";

// 「半夜跳日」回歸測試。台北比 UTC 快 8 小時,所以 UTC 16:00Z 之後台北已是
// 隔天 —— 這條若壞掉,使用者在台北深夜開頁面會看到「本週」提前或延後一天。
test("UTC 17:00Z → 台北已是隔天", () => {
	assert.equal(todayInTaipei(Date.parse("2026-07-19T17:00:00Z")), "2026-07-20");
});

test("UTC 15:59Z → 台北仍是當天", () => {
	assert.equal(todayInTaipei(Date.parse("2026-07-19T15:59:00Z")), "2026-07-19");
});

test("台北午夜的兩側:15:59:59Z 與 16:00:00Z 分屬前後兩天", () => {
	assert.equal(
		todayInTaipei(Date.parse("2026-07-19T15:59:59.999Z")),
		"2026-07-19",
	);
	assert.equal(todayInTaipei(Date.parse("2026-07-19T16:00:00Z")), "2026-07-20");
});

test("跨月 / 跨年邊界", () => {
	assert.equal(todayInTaipei(Date.parse("2026-07-31T16:00:00Z")), "2026-08-01");
	assert.equal(todayInTaipei(Date.parse("2025-12-31T16:00:00Z")), "2026-01-01");
});

test("偏移量就是 8 小時,與 SQL 的 '+8 hours' 同一個常數", () => {
	assert.equal(TAIPEI_OFFSET_MS, 8 * 3600 * 1000);
});

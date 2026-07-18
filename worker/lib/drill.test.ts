import { test } from "node:test";
import assert from "node:assert/strict";
import { pickInterleaved } from "./drill.ts";

test("盡量跨年:相同年份不連續霸佔前幾名", () => {
	const hits = [
		{ id: "113-a", year: 113 },
		{ id: "113-b", year: 113 },
		{ id: "112-a", year: 112 },
		{ id: "111-a", year: 111 },
	];
	const out = pickInterleaved(hits, { anchor: "x", n: 3, seed: 1 });
	assert.equal(out.length, 3);
	// 三題應橫跨三個不同年份 (round-robin),而非兩題 113
	assert.equal(new Set(out.map((h) => h.year)).size, 3);
});

test("排除 anchor、去重、長度受限於可用數", () => {
	const hits = [
		{ id: "a", year: 113 },
		{ id: "a", year: 113 }, // 重複
		{ id: "anc", year: 112 }, // anchor,須排除
	];
	const out = pickInterleaved(hits, { anchor: "anc", n: 5, seed: 2 });
	assert.deepEqual(
		out.map((h) => h.id),
		["a"],
	);
});

test("決定性:同 seed 同輸出", () => {
	const hits = [
		{ id: "1", year: 110 },
		{ id: "2", year: 111 },
		{ id: "3", year: 112 },
	];
	const a = pickInterleaved(hits, { anchor: "x", n: 3, seed: 7 });
	const b = pickInterleaved(hits, { anchor: "x", n: 3, seed: 7 });
	assert.deepEqual(a, b);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeSimilar } from "./similar.ts";

test("向量鄰居優先、去重、排除自身、補到上限", () => {
	const self = "114-001";
	const vec = [
		{ id: "113-050", score: 0.9 },
		{ id: "112-010", score: 0.8 },
		{ id: "114-001", score: 1 }, // self — must be excluded
	];
	const tag = [{ id: "112-010" }, { id: "111-003" }]; // 112-010 dup of vec
	const fts = [{ id: "110-020" }];
	const out = mergeSimilar({ self, vec, tag, fts, limit: 3 });
	assert.deepEqual(
		out.map((r) => r.id),
		["113-050", "112-010", "111-003"],
	);
	assert.equal(out[0].source, "vec");
	assert.equal(out[1].source, "vec");
	assert.equal(out[2].source, "tag");
});

test("向量結果不足時用 fts 補滿", () => {
	const out = mergeSimilar({
		self: "x",
		vec: [],
		tag: [],
		fts: [{ id: "a" }, { id: "b" }],
		limit: 5,
	});
	assert.deepEqual(
		out.map((r) => r.id),
		["a", "b"],
	);
	assert.equal(out[0].source, "fts");
});

test("不超過 limit,且未排序的 vec 依 score 由高到低", () => {
	const out = mergeSimilar({
		self: "self",
		vec: [
			{ id: "low", score: 0.1 },
			{ id: "high", score: 0.99 },
			{ id: "mid", score: 0.5 },
		],
		tag: [{ id: "extra" }],
		fts: [],
		limit: 2,
	});
	assert.deepEqual(
		out.map((r) => r.id),
		["high", "mid"],
	);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { clusterByThreshold } from "./cluster.ts";

test("兩個明顯分開的群被分成 2 群", () => {
	const items = [
		{ id: "a1", vector: [1, 0] },
		{ id: "a2", vector: [0.9, 0.1] },
		{ id: "b1", vector: [0, 1] },
		{ id: "b2", vector: [0.1, 0.9] },
	];
	const out = clusterByThreshold(items, { threshold: 0.8 });
	assert.equal(out.length, 2);
	assert.equal(out[0].members.length, 2);
	assert.equal(out[1].members.length, 2);
});

test("單題自成一群", () => {
	const out = clusterByThreshold([{ id: "x", vector: [1, 2, 3] }], {
		threshold: 0.9,
	});
	assert.deepEqual(out, [{ members: ["x"] }]);
});

test("空輸入 → 空", () => {
	assert.deepEqual(clusterByThreshold([], { threshold: 0.5 }), []);
});

test("依群大小降序排列", () => {
	const items = [
		{ id: "a1", vector: [1, 0] },
		{ id: "a2", vector: [1, 0.05] },
		{ id: "a3", vector: [0.98, 0.02] },
		{ id: "b1", vector: [0, 1] },
	];
	const out = clusterByThreshold(items, { threshold: 0.9 });
	assert.equal(out[0].members.length, 3);
	assert.equal(out[out.length - 1].members.length, 1);
});

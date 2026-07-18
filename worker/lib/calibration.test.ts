import { test } from "node:test";
import assert from "node:assert/strict";
import { calibration } from "./calibration.ts";

test("依信心分桶算正確率", () => {
	const out = calibration([
		{ confidence: 3, is_correct: 1 },
		{ confidence: 3, is_correct: 0 },
		{ confidence: 1, is_correct: 0 },
	]);
	assert.deepEqual(
		out.find((b) => b.confidence === 3),
		{ confidence: 3, n: 2, correct: 1, accuracy: 0.5 },
	);
	assert.equal(out.find((b) => b.confidence === 1)!.accuracy, 0);
});

test("空桶 accuracy 為 null、n 為 0", () => {
	const out = calibration([{ confidence: 2, is_correct: 1 }]);
	const b1 = out.find((b) => b.confidence === 1)!;
	assert.equal(b1.n, 0);
	assert.equal(b1.accuracy, null);
	const b2 = out.find((b) => b.confidence === 2)!;
	assert.equal(b2.accuracy, 1);
});

test("永遠回傳 1/2/3 三桶,順序固定", () => {
	const out = calibration([]);
	assert.deepEqual(
		out.map((b) => b.confidence),
		[1, 2, 3],
	);
	assert.ok(out.every((b) => b.n === 0 && b.accuracy === null));
});

test("忽略非 1/2/3 的雜訊信心值", () => {
	const out = calibration([
		{ confidence: 0, is_correct: 1 },
		{ confidence: 5, is_correct: 1 },
		{ confidence: 2, is_correct: 1 },
	]);
	assert.equal(out.reduce((s, b) => s + b.n, 0), 1);
});

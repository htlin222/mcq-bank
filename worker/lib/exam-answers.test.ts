import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planAnswerWrites } from './exam-answers.ts';

const stored = (o: Record<string, string | null>) => new Map(Object.entries(o));

test('答案沒變就不寫 —— 交卷全量重送的 99% 都落在這一條', () => {
	const plan = planAnswerWrites(
		[
			{ question_id: 'q1', chosen: 'A' },
			{ question_id: 'q2', chosen: 'B' },
		],
		stored({ q1: 'A', q2: 'B' }),
	);
	assert.deepEqual(plan.writes, []);
	assert.equal(plan.unchanged, 2);
});

test('改過的答案要寫,未作答(null)也算改', () => {
	const plan = planAnswerWrites(
		[
			{ question_id: 'q1', chosen: 'C' },
			{ question_id: 'q2', chosen: 'B' },
		],
		stored({ q1: 'A', q2: null }),
	);
	assert.deepEqual(plan.writes, [
		{ question_id: 'q1', chosen: 'C' },
		{ question_id: 'q2', chosen: 'B' },
	]);
	assert.equal(plan.unchanged, 0);
});

test('不屬於這場考試的題號單獨計數,不會混進 writes', () => {
	const plan = planAnswerWrites(
		[{ question_id: 'other', chosen: 'A' }],
		stored({ q1: null }),
	);
	assert.deepEqual(plan.writes, []);
	assert.equal(plan.unknown, 1);
});

test('型別不對的一律擋下,不丟例外', () => {
	const plan = planAnswerWrites(
		[
			{},
			{ question_id: 'q1' },
			{ question_id: 'q1', chosen: 3 as unknown },
			{ question_id: null as unknown, chosen: 'A' },
		],
		stored({ q1: null }),
	);
	assert.deepEqual(plan.writes, []);
	assert.equal(plan.invalid, 4);
});

// 同一題兩條 UPDATE 進同一個 batch,誰贏會變成「看 SQL 執行順序」——
// 那種順序沒有人看得出來為什麼。所以在這裡就收斂成一條。
test('同一題送兩次:後者覆蓋前者,而且只產生一條寫入', () => {
	const plan = planAnswerWrites(
		[
			{ question_id: 'q1', chosen: 'B' },
			{ question_id: 'q1', chosen: 'D' },
		],
		stored({ q1: 'A' }),
	);
	assert.deepEqual(plan.writes, [{ question_id: 'q1', chosen: 'D' }]);
});

test('送來的順序被保留 —— batch 的內容要是可預測的', () => {
	const plan = planAnswerWrites(
		[
			{ question_id: 'q3', chosen: 'A' },
			{ question_id: 'q1', chosen: 'A' },
		],
		stored({ q1: null, q2: null, q3: null }),
	);
	assert.deepEqual(
		plan.writes.map((w) => w.question_id),
		['q3', 'q1'],
	);
});

test('空輸入回空計畫', () => {
	const plan = planAnswerWrites([], stored({ q1: 'A' }));
	assert.deepEqual(plan, { writes: [], unchanged: 0, unknown: 0, invalid: 0 });
});

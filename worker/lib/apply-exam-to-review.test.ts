import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	pendingReviewSessions,
	planApplyToReview,
	type ExamAnswerRow,
	type PendingExamRow,
} from './apply-exam-to-review.ts';

const row = (p: Partial<ExamAnswerRow> & { question_id: string }): ExamAnswerRow => ({
	chosen: 'A',
	is_correct: 1,
	review_last_chosen: null,
	...p,
});

test('只登記考對的,考錯的一律不動', () => {
	const plan = planApplyToReview([
		row({ question_id: 'q1', chosen: 'A', is_correct: 1 }),
		row({ question_id: 'q2', chosen: 'B', is_correct: 0 }),
	]);
	assert.deepEqual(plan.apply, [{ question_id: 'q1', chosen: 'A' }]);
	assert.equal(plan.skipped_wrong, 1);
});

test('未作答(chosen 為 null)不算,即使 is_correct 是 1', () => {
	// 交卷補的空題會寫一列 chosen = NULL;不擋的話會把 null 寫進 last_chosen。
	const plan = planApplyToReview([
		row({ question_id: 'q1', chosen: null, is_correct: 1 }),
	]);
	assert.deepEqual(plan.apply, []);
	assert.equal(plan.skipped_wrong, 1);
});

test('尚未判定(is_correct 為 null)不算 —— 那是還沒交卷的 session', () => {
	const plan = planApplyToReview([
		row({ question_id: 'q1', chosen: 'A', is_correct: null }),
	]);
	assert.deepEqual(plan.apply, []);
});

// 批次按鈕上的數字要是「按下去會改變幾題」。把已經一樣的算進去,使用者會
// 按完發現數字沒動。
test('複習紀錄已經一樣的單獨計數,不進 apply', () => {
	const plan = planApplyToReview([
		row({ question_id: 'q1', chosen: 'A', review_last_chosen: 'A' }),
		row({ question_id: 'q2', chosen: 'C', review_last_chosen: 'B' }),
	]);
	assert.deepEqual(plan.apply, [{ question_id: 'q2', chosen: 'C' }]);
	assert.equal(plan.skipped_already, 1);
});

test('沒有複習紀錄的題目要登記(review_last_chosen 是 null)', () => {
	const plan = planApplyToReview([
		row({ question_id: 'q1', chosen: 'D', review_last_chosen: null }),
	]);
	assert.deepEqual(plan.apply, [{ question_id: 'q1', chosen: 'D' }]);
});

test('指定題號:只處理那幾題', () => {
	const plan = planApplyToReview(
		[
			row({ question_id: 'q1', chosen: 'A' }),
			row({ question_id: 'q2', chosen: 'B' }),
		],
		['q2'],
	);
	assert.deepEqual(plan.apply, [{ question_id: 'q2', chosen: 'B' }]);
});

test('指定了不屬於這場考試的題號 → 單獨計數,不靜靜吞掉', () => {
	const plan = planApplyToReview([row({ question_id: 'q1' })], ['q1', 'nope']);
	assert.equal(plan.unknown, 1);
	assert.equal(plan.apply.length, 1);
});

test('空的 requested 視同整場批次,不是「什麼都不做」', () => {
	const plan = planApplyToReview([row({ question_id: 'q1' })], []);
	assert.equal(plan.apply.length, 1);
});

function pending(p: Partial<PendingExamRow> & { session_id: string; question_id: string }): PendingExamRow {
	return {
		year: 113,
		finished_at: 100,
		score: 1,
		chosen: 'A',
		is_correct: 1,
		review_last_chosen: null,
		...p,
	};
}

test('未登記清單只留還有考對題要搬的場次,數字跟 planApplyToReview 一樣', () => {
	const out = pendingReviewSessions([
		pending({ session_id: 'old', question_id: 'q1', finished_at: 10 }),
		pending({ session_id: 'old', question_id: 'q2', is_correct: 0, finished_at: 10 }),
		pending({ session_id: 'done', question_id: 'q3', review_last_chosen: 'A', finished_at: 50 }),
		pending({ session_id: 'wrong-only', question_id: 'q4', is_correct: 0, finished_at: 80 }),
		pending({ session_id: 'open', question_id: 'q5', finished_at: null }),
		pending({ session_id: 'new', question_id: 'q6', finished_at: 90 }),
		pending({ session_id: 'new', question_id: 'q7', chosen: 'B', finished_at: 90 }),
	]);
	assert.deepEqual(
		out.map((s) => [s.id, s.pending]),
		[
			['new', 2],
			['old', 1],
		],
	);
});

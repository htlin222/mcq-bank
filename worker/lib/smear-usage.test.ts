import { test } from "node:test";
import assert from "node:assert/strict";
import {
	buildSmearUsage,
	reviewSpellingEligible,
	reviewSpellingExcludedSql,
	SMEAR_HINT_KINDS,
} from "./smear-usage.ts";

const TOPICS = ["myeloid", "lymphoid", "infection", "other"];

test("空資料每一種提示、俗名、主題都是 0,不是缺列", () => {
	const out = buildSmearUsage({}, TOPICS);
	assert.deepEqual(
		out.hints.map((h) => h.hint_used),
		[...SMEAR_HINT_KINDS],
	);
	assert.ok(out.hints.every((h) => h.n === 0));
	assert.equal(out.lay_hits, 0);
	assert.deepEqual(out.review_spelling, { correct: 0, graded: 0 });
	assert.deepEqual(
		out.topics.map((t) => [t.topic, t.question_count, t.answer_count]),
		TOPICS.map((t) => [t, 0, 0]),
	);
	assert.equal("spelling_ok" in out, false);
});

test("沒出現的提示補 0,多出來的種類留在已知清單後面", () => {
	const out = buildSmearUsage(
		{
			hintRows: [
				{ hint_used: "topic", n: 2 },
				{ hint_used: null, n: 4 },
				{ hint_used: "surprise", n: 1 },
			],
			layHits: 5,
		},
		TOPICS,
	);
	const by = Object.fromEntries(out.hints.map((h) => [h.hint_used, h.n]));
	assert.equal(by[""], 4);
	assert.equal(by.topic, 2);
	assert.equal(by.initial, 0);
	assert.equal(by.mc_choice, 0);
	assert.equal(out.hints.at(-1)?.hint_used, "surprise");
	assert.equal(out.lay_hits, 5);
});

test("沒人作答的主題題量仍在,作答數是 0;順序跟主題清單走", () => {
	const out = buildSmearUsage(
		{
			topicQuestions: [
				{ topic: "infection", question_count: 2 },
				{ topic: "rbc", question_count: 9 },
			],
			topicAnswers: [{ topic: "rbc", answer_count: 3 }],
		},
		TOPICS,
	);
	assert.deepEqual(
		out.topics.map((t) => [t.topic, t.question_count, t.answer_count]),
		[
			["myeloid", 0, 0],
			["lymphoid", 0, 0],
			["infection", 2, 0],
			["other", 0, 0],
			["rbc", 9, 3],
		],
	);
});

test("複習拼字正確率排除看選項與直接看答案", () => {
	assert.equal(reviewSpellingEligible(null), true);
	assert.equal(reviewSpellingEligible(""), true);
	assert.equal(reviewSpellingEligible("topic"), true);
	assert.equal(reviewSpellingEligible("initial"), true);
	assert.equal(reviewSpellingEligible("initial,topic"), true);
	assert.equal(reviewSpellingEligible("mc_choice"), false);
	assert.equal(reviewSpellingEligible("reveal_answer"), false);
	assert.equal(reviewSpellingExcludedSql(), "'mc_choice', 'reveal_answer'");
});

test("正確數不會大於分母", () => {
	const out = buildSmearUsage(
		{ reviewSpelling: { correct: 8, graded: 3 } },
		TOPICS,
	);
	assert.deepEqual(out.review_spelling, { correct: 3, graded: 3 });
});

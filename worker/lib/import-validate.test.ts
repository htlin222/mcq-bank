import { test } from "node:test";
import assert from "node:assert/strict";
import {
	assertPublishable,
	buildGroupComposition,
	groupForNumber,
	makeQuestionId,
	needsReview,
	validateStaged,
	type StagedQuestion,
} from "./import-validate.ts";

const COMP = buildGroupComposition("內科:70,共同:30");

function q(over: Partial<Record<string, unknown>> = {}) {
	return {
		number: 1,
		group: "內科",
		stem: "Which is correct?",
		options: { A: "a", B: "b", C: "c", D: "d", E: "e" },
		answer: "B",
		tags: ["AML"],
		explanation_doc: null,
		confidence: 1,
		...over,
	};
}

function staged(over: Partial<StagedQuestion> = {}): StagedQuestion {
	return {
		number: 1,
		group: "內科",
		stem: "s",
		options: { A: "a", B: "b", C: "c", D: "d" },
		answer: "A",
		tags: [],
		explanation_doc: null,
		confidence: 1,
		...over,
	};
}

// ---- group composition ----------------------------------------------------

test("GROUPS parses into contiguous number ranges", () => {
	assert.deepEqual(COMP.groups, [
		{ label: "內科", count: 70, startNumber: 1, endNumber: 70 },
		{ label: "共同", count: 30, startNumber: 71, endNumber: 100 },
	]);
	assert.equal(COMP.total, 100);
});

test("groupForNumber maps boundaries to the right group", () => {
	assert.equal(groupForNumber(COMP, 1), "內科");
	assert.equal(groupForNumber(COMP, 70), "內科");
	assert.equal(groupForNumber(COMP, 71), "共同");
	assert.equal(groupForNumber(COMP, 100), "共同");
	assert.equal(groupForNumber(COMP, 101), null);
});

test("malformed GROUPS entries are skipped, not fatal", () => {
	const c = buildGroupComposition("內科:70,garbage,共同:30");
	assert.equal(c.total, 100);
	assert.equal(c.groups.length, 2);
});

test("unset GROUPS yields an empty composition", () => {
	assert.equal(buildGroupComposition(undefined).total, 0);
});

// ---- staging gate ---------------------------------------------------------

test("a well-formed question stages cleanly", () => {
	const r = validateStaged(q(), COMP);
	assert.deepEqual(r.errors, []);
	assert.equal(r.value?.answer, "B");
});

test("an unanswered question is allowed at staging", () => {
	// This is the whole point of the staging area: the parser is permitted to
	// give up, and a human resolves it in the browser afterwards.
	const r = validateStaged(q({ answer: "", confidence: 0 }), COMP);
	assert.deepEqual(r.errors, []);
	assert.equal(r.value?.answer, "");
});

test("answer must be one of the question's own options", () => {
	const r = validateStaged(q({ options: { A: "a", B: "b", C: "c", D: "d" }, answer: "E" }), COMP);
	assert.match(r.errors.join(" "), /answer E is not one of/);
});

test("a number in the wrong group is rejected", () => {
	const r = validateStaged(q({ number: 80, group: "內科" }), COMP);
	assert.match(r.errors.join(" "), /belongs to 共同/);
});

test("four-option questions are fine; A-D are not", () => {
	assert.deepEqual(validateStaged(q({ options: { A: "a", B: "b", C: "c", D: "d" } }), COMP).errors, []);
	const r = validateStaged(q({ options: { A: "a", B: "b", C: "c" }, answer: "A" }), COMP);
	assert.match(r.errors.join(" "), /option D is required/);
});

test("answer letters are upper-cased before matching", () => {
	assert.equal(validateStaged(q({ answer: "b" }), COMP).value?.answer, "B");
});

test("explanation_doc must be a TipTap doc node", () => {
	assert.match(
		validateStaged(q({ explanation_doc: { type: "paragraph" } }), COMP).errors.join(" "),
		/TipTap doc node/,
	);
	assert.deepEqual(
		validateStaged(q({ explanation_doc: { type: "doc", content: [] } }), COMP).errors,
		[],
	);
});

test("tags are trimmed, capped, and non-strings dropped", () => {
	const r = validateStaged(
		q({ tags: ["  AML  ", 42, "", "x".repeat(999), "a", "b", "c", "d", "e", "f", "g", "h", "i"] }),
		COMP,
	);
	assert.deepEqual(r.errors, []);
	assert.equal(r.value?.tags[0], "AML");
	assert.ok((r.value?.tags.length ?? 0) <= 8);
});

test("non-objects are rejected outright", () => {
	assert.deepEqual(validateStaged(null, COMP).errors, ["not an object"]);
	assert.deepEqual(validateStaged([1, 2], COMP).errors, ["not an object"]);
});

// ---- review flagging ------------------------------------------------------

test("missing answers and low confidence both flag for review", () => {
	assert.equal(needsReview(staged({ answer: "" })), true);
	assert.equal(needsReview(staged({ confidence: 0.5 })), true);
	assert.equal(needsReview(staged({ confidence: 1 })), false);
});

// ---- publish gate ---------------------------------------------------------

function fullYear(over: (n: number) => Partial<StagedQuestion> = () => ({})): StagedQuestion[] {
	return Array.from({ length: 100 }, (_, i) =>
		staged({
			number: i + 1,
			group: i < 70 ? "內科" : "共同",
			...over(i + 1),
		}),
	);
}

test("a complete year publishes", () => {
	assert.deepEqual(assertPublishable(fullYear(), COMP), []);
});

test("publish refuses a year with any unanswered question", () => {
	const qs = fullYear((n) => (n === 47 ? { answer: "" } : {}));
	assert.match(assertPublishable(qs, COMP).join(" "), /no answer: 47/);
});

test("publish refuses a short year and names the gaps", () => {
	const qs = fullYear().filter((x) => x.number !== 5 && x.number !== 6);
	const errs = assertPublishable(qs, COMP).join(" ");
	assert.match(errs, /expected 100 questions, staged 98/);
	assert.match(errs, /missing numbers: 5, 6/);
});

test("publish refuses duplicate numbers", () => {
	const qs = fullYear();
	qs[1] = staged({ number: 1, group: "內科" });
	assert.match(assertPublishable(qs, COMP).join(" "), /duplicate number 1/);
});

test("long gap lists are truncated rather than dumped whole", () => {
	const errs = assertPublishable([staged({ number: 1 })], COMP).join(" ");
	assert.match(errs, /\(\+79\)/);
});

test("publish refuses when GROUPS is unconfigured", () => {
	assert.match(
		assertPublishable([], buildGroupComposition("")).join(" "),
		/GROUPS is not configured/,
	);
});

// ---- id format ------------------------------------------------------------

test("question ids match the existing importer's format", () => {
	assert.equal(makeQuestionId(115, 1), "115-001");
	assert.equal(makeQuestionId(115, 100), "115-100");
});

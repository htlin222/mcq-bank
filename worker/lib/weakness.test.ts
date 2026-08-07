import { test } from "node:test";
import assert from "node:assert/strict";
import { groupByTopic } from "./weakness.ts";

// 錯題順序 = 最近答錯的排前面。anchor 取「在這個主題裡最近錯的那一題」,
// 所以交錯練習會從記憶最新的地方開始,而且同樣輸入必然得到同樣輸出。
const ORDER = ["113-072", "113-071", "114-005", "112-003", "111-009"];

const rows = [
	{ slug: "vwd", label: "von Willebrand 病", question_id: "113-071" },
	{ slug: "vwd", label: "von Willebrand 病", question_id: "114-005" },
	{ slug: "aml", label: "AML", question_id: "113-072" },
	{ slug: "aml", label: "AML", question_id: "112-003" },
	{ slug: "aml", label: "AML", question_id: "111-009" },
];

test("依主題分群,大的排前面", () => {
	const out = groupByTopic(rows, ORDER);
	assert.deepEqual(
		out.map((c) => [c.label, c.size]),
		[
			["AML", 3],
			["von Willebrand 病", 2],
		],
	);
});

test("anchor 取該群中最近答錯的那一題", () => {
	const out = groupByTopic(rows, ORDER);
	assert.equal(out.find((c) => c.label === "AML")?.anchor, "113-072");
	assert.equal(out.find((c) => c.label.startsWith("von"))?.anchor, "113-071");
});

test("同一題掛到同主題的多個標籤只算一次", () => {
	const dup = [
		...rows,
		{ slug: "aml", label: "AML", question_id: "113-072" },
		{ slug: "aml", label: "AML", question_id: "113-072" },
	];
	assert.equal(groupByTopic(dup, ORDER).find((c) => c.label === "AML")?.size, 3);
});

test("只有一題的主題不成群 —— 那是雜訊不是弱點", () => {
	const out = groupByTopic(
		[{ slug: "solo", label: "孤兒主題", question_id: "113-072" }],
		ORDER,
	);
	assert.deepEqual(out, []);
});

test("min 可調;設 1 時單題主題也留下", () => {
	const out = groupByTopic(
		[{ slug: "solo", label: "孤兒主題", question_id: "113-072" }],
		ORDER,
		{ min: 1 },
	);
	assert.deepEqual(
		out.map((c) => [c.label, c.size, c.anchor]),
		[["孤兒主題", 1, "113-072"]],
	);
});

test("同樣大小的群依 label 排序,輸出才是決定性的", () => {
	const tie = [
		{ slug: "b", label: "B 主題", question_id: "113-072" },
		{ slug: "b", label: "B 主題", question_id: "113-071" },
		{ slug: "a", label: "A 主題", question_id: "114-005" },
		{ slug: "a", label: "A 主題", question_id: "112-003" },
	];
	assert.deepEqual(
		groupByTopic(tie, ORDER).map((c) => c.label),
		["A 主題", "B 主題"],
	);
});

test("limit 砍掉尾巴,但砍的是最小的那些", () => {
	const out = groupByTopic(rows, ORDER, { limit: 1 });
	assert.deepEqual(
		out.map((c) => c.label),
		["AML"],
	);
});

test("不在 order 裡的題目仍然算數,只是排在最後當 anchor 候選", () => {
	const out = groupByTopic(
		[
			{ slug: "x", label: "X", question_id: "999-999" },
			{ slug: "x", label: "X", question_id: "113-071" },
		],
		ORDER,
	);
	assert.equal(out[0].anchor, "113-071", "已知順序的優先");
	assert.equal(out[0].size, 2);
});

test("空輸入回空陣列,不丟例外", () => {
	assert.deepEqual(groupByTopic([], ORDER), []);
});

test("order 全空時退回「第一個看到的」當 anchor,不是丟例外", () => {
	const out = groupByTopic(rows, []);
	assert.equal(out.find((c) => c.label === "AML")?.anchor, "113-072");
	assert.deepEqual(out.find((c) => c.label === "AML")?.question_ids, [
		"113-072",
		"112-003",
		"111-009",
	]);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_TERMS, parseExpandResponse } from "./search-expand.ts";

// ⚠️ 這一支守的是**解析器**,不是模型。模型會不會給出好的同義詞不在這裡驗
// (那要真的呼叫 Workers AI);這裡驗的是「不管它回什麼形狀,我們都不會把一整句
// 話當成搜尋詞丟進 FTS」—— 那個失敗的樣子是查出 0 筆,而使用者只會覺得
// 「AI 搜尋沒用」。

test("一行逗號分隔 —— 最理想的那種", () => {
	const out = parseExpandResponse(
		{ response: "AML, acute myeloid leukemia, 急性骨髓性白血病" },
		"AML",
	);
	assert.deepEqual(out, ["AML", "acute myeloid leukemia", "急性骨髓性白血病"]);
});

test("原查詢永遠排第一,而且不會重複", () => {
	// 模型多半會把原字也吐回來 —— 那不該變成兩個一樣的詞。
	const out = parseExpandResponse({ response: "aml, AML, acute myeloid leukemia" }, "AML");
	assert.equal(out[0], "AML");
	assert.equal(out.filter((t) => t.toLowerCase() === "aml").length, 1);
});

test("條列 / 編號 / 引號都吃得下來", () => {
	const out = parseExpandResponse(
		{ response: '1. body\n2. bodies\n- "Body"\n* 身體' },
		"body",
	);
	assert.deepEqual(out, ["body", "bodies", "身體"]);
});

test("JSON 陣列也接", () => {
	const out = parseExpandResponse({ response: '["CML","chronic myeloid leukemia"]' }, "CML");
	assert.deepEqual(out, ["CML", "chronic myeloid leukemia"]);
});

test("**開場白與說明句要被丟掉**", () => {
	// 這是最重要的一條:「Here are the terms:」進了查詢,整串 OR 會被一段永遠比不到
	// 的長句拖著,而畫面上只是「沒有結果」。
	const out = parseExpandResponse(
		{
			response:
				"Here are the variants: AML, acute myeloid leukemia\nNote: this is the most common form of acute leukemia in adults.",
		},
		"AML",
	);
	assert.ok(!out.some((t) => /Here are/i.test(t)), `開場白沒被丟掉:${JSON.stringify(out)}`);
	assert.ok(!out.some((t) => /most common form/i.test(t)), `說明句沒被丟掉:${JSON.stringify(out)}`);
	assert.ok(out.includes("acute myeloid leukemia"));
});

test("太長的、字太多的一律不算詞", () => {
	const long = "a".repeat(80);
	const wordy = "one two three four five six seven";
	const out = parseExpandResponse({ response: `${long}\n${wordy}\nbodies` }, "body");
	assert.deepEqual(out, ["body", "bodies"]);
});

test(`最多 ${MAX_TERMS} 個 —— 再多會把結果稀釋掉`, () => {
	const many = Array.from({ length: 30 }, (_, i) => `term${i}`).join(", ");
	const out = parseExpandResponse({ response: many }, "x");
	assert.equal(out.length, MAX_TERMS);
	assert.equal(out[0], "x");
});

test("模型整批答非所問時,至少退化成原查詢", () => {
	// 最差的情況只能是「跟沒按那顆按鈕一樣」,不能是「按了之後反而找不到東西」。
	assert.deepEqual(parseExpandResponse({ response: "" }, "AML"), ["AML"]);
	assert.deepEqual(parseExpandResponse({ response: "I cannot help with that." }, "AML"), ["AML"]);
	assert.deepEqual(parseExpandResponse(null, "AML"), ["AML"]);
	assert.deepEqual(parseExpandResponse({ nope: 1 }, "AML"), ["AML"]);
});

test("回應是純字串時也要拿得到 —— AI.run 的形狀不保證", () => {
	assert.deepEqual(parseExpandResponse("AML, acute myeloid leukemia", "AML"), [
		"AML",
		"acute myeloid leukemia",
	]);
});

test("展開出來的詞裡不會再有逗號 —— 否則接上 OR 會多切一刀", () => {
	const out = parseExpandResponse({ response: "AML, acute myeloid leukemia" }, "AML");
	assert.ok(out.every((t) => !t.includes(",") && !t.includes("，")), JSON.stringify(out));
});

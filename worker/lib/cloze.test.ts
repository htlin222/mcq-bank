import { test } from "node:test";
import assert from "node:assert/strict";
import { explanationPlainText, dedupeTerms, hashText } from "./cloze.ts";

test("攤平 TipTap 文字 (段落內相鄰 text 串接)", () => {
	const doc = {
		type: "doc",
		content: [
			{
				type: "paragraph",
				content: [
					{ type: "text", text: "CML 帶有 " },
					{ type: "text", text: "BCR-ABL1" },
				],
			},
		],
	};
	assert.equal(explanationPlainText(doc), "CML 帶有 BCR-ABL1");
});

test("跨段落以換行分隔,不黏在一起", () => {
	const doc = {
		type: "doc",
		content: [
			{ type: "paragraph", content: [{ type: "text", text: "第一段" }] },
			{ type: "paragraph", content: [{ type: "text", text: "第二段" }] },
		],
	};
	assert.equal(explanationPlainText(doc), "第一段\n第二段");
});

test("關鍵詞去重、去頭尾空白、剔除過短、限量 50", () => {
	assert.deepEqual(dedupeTerms([" BCR-ABL1 ", "BCR-ABL1", "的", "TKI"]), [
		"BCR-ABL1",
		"TKI",
	]);
	const many = Array.from({ length: 80 }, (_, i) => `term${i}`);
	assert.equal(dedupeTerms(many).length, 50);
});

test("hashText 穩定、對內容敏感", () => {
	assert.equal(hashText("abc"), hashText("abc"));
	assert.notEqual(hashText("abc"), hashText("abd"));
	assert.equal(hashText(""), hashText(""));
});

test("空輸入 / 非陣列安全回空", () => {
	assert.deepEqual(dedupeTerms([]), []);
	assert.equal(explanationPlainText(null), "");
	assert.equal(explanationPlainText({ type: "doc" }), "");
});

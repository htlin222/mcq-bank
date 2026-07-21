import { test } from "node:test";
import assert from "node:assert/strict";
import {
	plainTextFromDoc,
	extractTerms,
	mergeTopSuggestions,
} from "./note-terms.ts";

test("plainTextFromDoc 攤平巢狀 TipTap 文字節點", () => {
	const doc = {
		type: "doc",
		content: [
			{
				type: "paragraph",
				content: [
					{ type: "text", text: "AML 的" },
					{ type: "text", text: "誘導化療" },
				],
			},
			{ type: "horizontalRule" },
			{
				type: "bulletList",
				content: [
					{
						type: "listItem",
						content: [
							{ type: "paragraph", content: [{ type: "text", text: "APL" }] },
						],
					},
				],
			},
		],
	};
	const text = plainTextFromDoc(doc);
	assert.ok(text.includes("AML"));
	assert.ok(text.includes("誘導化療"));
	assert.ok(text.includes("APL"));
});

test("plainTextFromDoc 對壞輸入不丟例外", () => {
	assert.equal(plainTextFromDoc(null), "");
	assert.equal(plainTextFromDoc(42), "");
	assert.equal(plainTextFromDoc({}), "");
});

test("extractTerms:ASCII 縮寫有邊界、CJK 走子字串", () => {
	const vocab = ["AML", "MDS", "APL", "白血病", "誘導化療"];
	// "AML" 命中;"MDS" 不該在 "MDSx" 裡誤觸;"白血病" 子字串命中。
	const text = "本題談 AML 與 MDSx 無關，屬急性白血病，需要誘導化療。";
	const terms = extractTerms(text, vocab);
	assert.deepEqual(terms.sort(), ["AML", "白血病", "誘導化療"].sort());
	assert.ok(!terms.includes("MDS"));
	assert.ok(!terms.includes("APL"));
});

test("extractTerms:大小寫不敏感、去重、上限", () => {
	const vocab = ["aml", "AML", "iron"];
	const terms = extractTerms("aml AML Aml iron", vocab);
	// "aml"/"AML" 視為同一詞(去重),外加 iron
	assert.equal(terms.filter((t) => t.toLowerCase() === "aml").length, 1);
	assert.ok(terms.some((t) => t.toLowerCase() === "iron"));

	const many = Array.from({ length: 50 }, (_, i) => `t${i}`);
	const bigText = many.join(" ");
	assert.equal(extractTerms(bigText, many, { max: 5 }).length, 5);
});

test("mergeTopSuggestions:過門檻、依分數排序、去尾、混合 kind", () => {
	const cands = [
		{ targetKind: "question" as const, targetId: "113-005", score: 3.1, sharedTerms: ["AML"] },
		{ targetKind: "note" as const, targetId: "112-010", score: 5.0, sharedTerms: ["APL", "AML"] },
		{ targetKind: "question" as const, targetId: "111-002", score: 0.2, sharedTerms: ["血液"] }, // 低分被砍
		{ targetKind: "question" as const, targetId: "110-009", score: 1.5, sharedTerms: [] }, // 無共享詞被砍
	];
	const out = mergeTopSuggestions(cands, { limit: 5, minScore: 1.0 });
	assert.deepEqual(
		out.map((c) => c.targetId),
		["112-010", "113-005"],
	);
	assert.equal(out[0].targetKind, "note");
});

test("mergeTopSuggestions:limit 上限即連結密度護欄", () => {
	const cands = Array.from({ length: 10 }, (_, i) => ({
		targetKind: "question" as const,
		targetId: `q${i}`,
		score: 10 - i,
		sharedTerms: ["AML"],
	}));
	assert.equal(mergeTopSuggestions(cands, { limit: 5, minScore: 0 }).length, 5);
});

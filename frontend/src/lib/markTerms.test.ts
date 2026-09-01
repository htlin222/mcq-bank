import { test } from "node:test";
import assert from "node:assert/strict";
import { markTerms, queryTerms } from "./markTerms.ts";

const joined = (parts: { text: string }[]) => parts.map((p) => p.text).join("");
const hits = (parts: { text: string; hit: boolean }[]) =>
	parts.filter((p) => p.hit).map((p) => p.text);

test("查詢切詞:逗號(含全形)與空白都是分隔符", () => {
	assert.deepEqual(queryTerms("AML, CML"), ["AML", "CML"]);
	assert.deepEqual(queryTerms("AML，CML"), ["AML", "CML"]);
	assert.deepEqual(queryTerms("acute myeloid"), ["acute", "myeloid"]);
});

test("FTS5 的運算子要丟掉 —— 標起來會讓人以為那是命中", () => {
	assert.deepEqual(queryTerms("AML OR CML"), ["AML", "CML"]);
	assert.deepEqual(queryTerms("AML NOT chronic"), ["AML", "chronic"]);
	// 小寫的 or 在 FTS5 是一般的詞,所以要留著。
	assert.deepEqual(queryTerms("AML or CML"), ["AML", "or", "CML"]);
});

test("尾端的 * 要剝掉 —— 那是語法不是使用者要找的字", () => {
	assert.deepEqual(queryTerms("AML*"), ["AML"]);
});

test("**引號內是一個整體**", () => {
	// 使用者打引號的用意正好是「這幾個字要連在一起」,拆開分別標等於把那個意思
	// 丟掉。切法要跟 worker/lib/fts-query.ts 一致。
	assert.deepEqual(queryTerms('"lupus erythematosus"'), ["lupus erythematosus"]);
	assert.deepEqual(queryTerms('"lupus erythematosus" nephritis'), [
		"lupus erythematosus",
		"nephritis",
	]);
	// 全形與 CJK 引號都認。
	assert.deepEqual(queryTerms("\u300c慢性骨髓\u300d"), ["慢性骨髓"]);
	assert.deepEqual(queryTerms("\u201clupus erythematosus\u201d"), ["lupus erythematosus"]);
});

test("標記不改變原文", () => {
	const text = "acute myeloid leukemia 的治療";
	assert.equal(joined(markTerms(text, ["myeloid"])), text);
});

test("大小寫不分 —— 要跟 FTS5 的 case folding 一致", () => {
	assert.deepEqual(hits(markTerms("Acute Myeloid Leukemia", ["myeloid"])), ["Myeloid"]);
});

test("**長的詞優先** —— 不排序的話標出來的範圍會比使用者打的短", () => {
	// `|` 是取第一個對得上的分支,不是取最長。順序做在組正則的地方,
	// 不要求呼叫端自己排(同 stemHighlight.ts 那條)。
	assert.deepEqual(
		hits(markTerms("acute myeloid leukemia", ["acute", "acute myeloid"])),
		["acute myeloid"],
	);
});

test("多個詞、多次出現都要標到", () => {
	assert.deepEqual(
		hits(markTerms("AML 與 CML 都是 AML 家族", ["AML", "CML"])),
		["AML", "CML", "AML"],
	);
});

test("中文不卡字界", () => {
	assert.deepEqual(hits(markTerms("慢性骨髓性白血病", ["白血病"])), ["白血病"]);
});

test("正則元字元不會炸掉 —— 搜尋框可以打任何東西", () => {
	const text = "BCR::ABL1 (p210) 陽性";
	assert.doesNotThrow(() => markTerms(text, ["(p210)", "BCR::ABL1", "*", "+"]));
	assert.equal(joined(markTerms(text, ["(p210)"])), text);
	assert.deepEqual(hits(markTerms(text, ["(p210)"])), ["(p210)"]);
});

test("沒有詞、或一個都比不到時原樣回傳一段", () => {
	assert.deepEqual(markTerms("abc", []), [{ text: "abc", hit: false }]);
	assert.deepEqual(markTerms("abc", ["zzz"]), [{ text: "abc", hit: false }]);
});

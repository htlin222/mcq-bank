import { test } from "node:test";
import assert from "node:assert/strict";
import { optionHits, termsMissingFromStem } from "./optionHits.ts";

// 搜尋索引涵蓋題幹 + 選項 + 標籤,所以一題完全可以因為某個選項裡的字被找出來
// —— 而題幹上一個標記都沒有。舊版靠 FTS5 的 snippet() 自己解釋這件事;換成
// 「整段題幹 + client 標記」之後那個解釋沒了。

const OPTS = {
	A: "Imatinib 為第一線治療",
	B: "一經診斷即應立即安排異體骨髓移植",
	C: "慢性期仍建議每三個月做骨髓穿刺",
};

test("挑出「不在題幹裡」的那幾個詞(不分大小寫)", () => {
	assert.deepEqual(termsMissingFromStem("Acute Myeloid Leukemia", ["myeloid"]), []);
	assert.deepEqual(termsMissingFromStem("慢性骨髓性白血病", ["白血病"]), []);
	assert.deepEqual(termsMissingFromStem("慢性骨髓性白血病", ["淋巴瘤"]), ["淋巴瘤"]);
});

test("**逐個詞判斷,不是「題幹有沒有命中」** —— 這正是回報的那個情況", () => {
	// 「搜 lupus erythematosus disease,結果只有 disease 也會找到」:題幹確實有
	// disease(舊判準因此認為「不用解釋」),而另外兩個字落在選項裡。
	assert.deepEqual(
		termsMissingFromStem("lupus is a disease", ["lupus", "erythematosus", "disease"]),
		["erythematosus"],
	);
});

test("找得出命中在哪幾個選項", () => {
	assert.deepEqual(
		optionHits(OPTS, ["imatinib"]).map((o) => o.key),
		["A"],
	);
	// 多個選項都中時要全部列出來 —— 只講第一個會讓人以為只有那一個相關。
	assert.deepEqual(
		optionHits(OPTS, ["骨髓"]).map((o) => o.key),
		["B", "C"],
	);
});

test("沒有選項 / 沒有詞 / 一個都沒中時回空陣列", () => {
	assert.deepEqual(optionHits(undefined, ["x"]), []);
	assert.deepEqual(optionHits(OPTS, []), []);
	assert.deepEqual(optionHits(OPTS, [""]), []);
	assert.deepEqual(optionHits(OPTS, ["淋巴瘤"]), []);
});

test("回的是字母 + 全文 —— 畫面上要講「符合選項 A:…」", () => {
	assert.deepEqual(optionHits(OPTS, ["imatinib"]), [
		{ key: "A", text: OPTS.A },
	]);
});

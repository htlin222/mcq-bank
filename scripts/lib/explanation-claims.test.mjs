import { test } from "node:test";
import assert from "node:assert/strict";
import {
	assertReadOnlySql,
	claimedLetters,
	classifyExplanation,
	CONFLICT_SQL,
	explanationText,
	formatReport,
} from "./explanation-claims.mjs";

test("詳解寫 A、欄位是 B，清單上是衝突", () => {
	const row = classifyExplanation({
		id: "114-001",
		answer: "B",
		text: "綜合上述，故答案為A。",
		hasHistory: true,
	});
	assert.equal(row.kind, "conflict");
	assert.equal(row.claimed, "A");
	assert.equal(row.answer, "B");
	assert.equal(row.hasHistory, true);
	const report = formatReport([row]);
	assert.match(report, /^衝突 1/);
	assert.match(report, /114-001\t欄位 B\t詳解 A\t有答案紀錄/);
});

test("沒有宣稱答案的詳解不是衝突", () => {
	const row = classifyExplanation({
		id: "114-019",
		answer: "C",
		text: "此答案由 OpenEvidence 確認。非不利因子，故為答案。",
		hasHistory: false,
	});
	assert.equal(row.kind, "unparsed");
	assert.equal(row.reason, "none");
	const report = formatReport([row]);
	assert.match(report, /^衝突 0/);
	assert.match(report, /114-019\t沒有可辨認的答案句/);
	assert.doesNotMatch(report, /114-019\t欄位/);
});

test("空白詳解略過，不進衝突也不進未解析", () => {
	const row = classifyExplanation({
		id: "100-001",
		answer: "A",
		text: "  ",
	});
	assert.equal(row.kind, "skipped");
	const report = formatReport([row]);
	assert.match(report, /衝突 0/);
	assert.match(report, /未解析 0/);
	assert.match(report, /沒有詳解 1/);
});

test("同時宣稱兩個選項時不猜，進未解析", () => {
	const row = classifyExplanation({
		id: "112-002",
		answer: "E",
		text: "正解：(E) 2+3+4。Table 55.4 標示答案為 (C)。",
	});
	assert.equal(row.kind, "unparsed");
	assert.equal(row.reason, "many");
	assert.deepEqual(row.letters, ["C", "E"]);
	assert.match(formatReport([row]), /宣稱了不只一個選項：C、E/);
});

test("否定句與英文縮寫不是選項", () => {
	assert.deepEqual(claimedLetters("故答案(C)錯誤；其餘選項正確。"), []);
	assert.deepEqual(claimedLetters("正確答案為 CD71，但無法對上選項。"), []);
	assert.deepEqual(claimedLetters("故選項 (C) 敘述錯誤。"), []);
	assert.deepEqual(claimedLetters("答案(C)。"), ["C"]);
	assert.deepEqual(claimedLetters("正解：（來源缺漏，無法確認）"), []);
});

test("全形字母與緊貼的答案句認得出來，而且跟欄位相同就不算衝突", () => {
	assert.deepEqual(claimedLetters("正解：(Ｄ)"), ["D"]);
	assert.deepEqual(claimedLetters("反而是出血減少。答案C。"), ["C"]);
	assert.deepEqual(claimedLetters("故選 (B)"), ["B"]);
	const row = classifyExplanation({
		id: "113-001",
		answer: "d",
		text: "正解：(Ｄ) High risk group",
	});
	assert.equal(row.kind, "agree");
	assert.equal(row.claimed, "D");
});

test("TipTap JSON 的文字節點會被攤平後再認", () => {
	const text = explanationText(
		JSON.stringify({
			type: "doc",
			content: [
				{
					type: "paragraph",
					content: [{ type: "text", text: "故選 (A)。" }],
				},
			],
		}),
	);
	assert.equal(text, "故選 (A)。");
	assert.deepEqual(claimedLetters(text), ["A"]);
});

test("查詢是單一支 SELECT", () => {
	assert.doesNotThrow(() => assertReadOnlySql(CONFLICT_SQL));
	assert.match(CONFLICT_SQL, /answer_history/);
	assert.throws(() => assertReadOnlySql("UPDATE questions SET answer = 'A'"));
	assert.throws(() =>
		assertReadOnlySql("SELECT 1; UPDATE questions SET answer = 'A'"),
	);
});

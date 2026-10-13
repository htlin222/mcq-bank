import { test } from "node:test";
import assert from "node:assert/strict";
import { optionCut, optionCutPhrase } from "./option-truncation.ts";

test("括號沒關上是截斷，#84 那種真的被切掉的選項要紅", () => {
	assert.equal(optionCut("Lymphomatoid granulomatosis ("), "paren");
	assert.equal(optionCut("Primary cutaneous DLBCL, leg type ("), "paren");
	assert.equal(optionCut("microangiopathic hemolytic anemia ( ("), "paren");
	assert.equal(optionCut("megaloblastic anemia ("), "paren");
	assert.equal(
		optionCut("Patients typically become symptomatic when serum calcium exceeds 12 mg/dL (3"),
		"paren",
	);
	assert.equal(optionCut("全形括號沒關（"), "paren");
	assert.equal(optionCut("see the table [3"), "paren");
});

test("長的小寫單字停在連字號上是字母中段", () => {
	assert.equal(
		optionCut("Metabolic abnormalities in ATLS including: hyperuricem-"),
		"letter",
	);
	// 五個字母的連字號留著。短到跟 `kappa-` 分不開，不能拿來整批拒絕。
	assert.equal(optionCut("chemo-"), null);
	assert.equal(optionCutPhrase("letter"), "mid-word");
	assert.equal(optionCutPhrase("paren"), "mid-parenthesis");
});

test("正常結尾不拒：句點、問號、縮寫、完整單字", () => {
	for (const text of [
		"Persistence of blasts was considered an unfavorable factor.",
		"Which of the following is indicated?",
		"下列何者正確？",
		"下列何者正確。",
		"etc.",
		"e.g.",
		"i.e.",
		"All of the above",
		"most of adult ALL studies",
		"none of the above",
		"anti-e",
		"C3d",
		"mg/dL",
		"15mg/kg/d",
		"FLAG-ida",
		"follow-up",
		"and justify long-term follow-up",
	]) {
		assert.equal(optionCut(text), null, text);
	}
});

test("免疫標記的陰性連字號不是截斷", () => {
	for (const text of [
		"kappa-",
		"lambda-",
		"TdT-",
		"CD15-",
		"HLA-DR-",
		"CD30+, CD20+, CD15-",
		"CD5-, CD10-, CD23-",
	]) {
		assert.equal(optionCut(text), null, text);
	}
});

test("多出來的右括號、配平的括號、逗號收尾，都不算括號中段", () => {
	assert.equal(
		optionCut(
			"platelet count < 30 x 109/L and creatine level less than 2.0 mg/dL) can help guide empiric treatment.",
		),
		null,
	);
	assert.equal(
		optionCut(
			"MYC and BCL2 translocations for identification of “double-hit）” or “triple-hit” lymphoma",
		),
		null,
	);
	assert.equal(
		optionCut(
			"球型血球症(Hereditary spherocytosis, HS)常是體染色體顯性(autosomal dominant)遺",
		),
		null,
	);
	assert.equal(
		optionCut("Metabolic abnormalities in ATLS including: hyperuricemia,"),
		null,
	);
	assert.equal(optionCut("Hyperkalemia plays the major role seen in"), null);
	assert.equal(optionCut("chemotherapy should"), null);
});

test("空白不算截斷", () => {
	assert.equal(optionCut(""), null);
	assert.equal(optionCut("   "), null);
	assert.equal(optionCut("  Lymphomatoid granulomatosis (  "), "paren");
});

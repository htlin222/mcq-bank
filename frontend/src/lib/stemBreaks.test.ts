import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeStemBreaks } from "./stemBreaks.ts";

test("句中被 PDF 換行切開的一句話會接回去", () => {
	assert.equal(
		normalizeStemBreaks(
			"Of parenteral 1000µg cyanoCbl intramuscular or subcutaneous\n\ninjection, about 150µg will be retained",
		),
		"Of parenteral 1000µg cyanoCbl intramuscular or subcutaneous injection, about 150µg will be retained",
	);
});

test("編號項目前的換行留著 —— 那是真的分行", () => {
	const s = "下列敘述何者正確?\n(1)第一項\n(2)第二項\n(3)第三項";
	assert.equal(normalizeStemBreaks(s), s);
});

test("全形編號、以及 1. 這種寫法也算項目", () => {
	const s = "題幹\n（1）第一項\n2.第二項";
	assert.equal(normalizeStemBreaks(s), s);
});

test("選項標記 (A) 開頭的行也不接", () => {
	const s = "題幹如下\n(A) 第一個選項";
	assert.equal(normalizeStemBreaks(s), s);
});

test("句號結尾的換行是段落,保留", () => {
	const s = "第一段結束了。\n第二段開始";
	assert.equal(normalizeStemBreaks(s), s);
	assert.equal(
		normalizeStemBreaks("Ends here.\nNew paragraph"),
		"Ends here.\nNew paragraph",
	);
});

test("接回去時中英之間補一個空白,中文之間不補", () => {
	assert.equal(
		normalizeStemBreaks("the patient was\ntreated with"),
		"the patient was treated with",
	);
	assert.equal(
		normalizeStemBreaks("這個病人接受了\n化學治療"),
		"這個病人接受了化學治療",
	);
});

test("連續空行壓成一個換行,不留一片空白", () => {
	assert.equal(
		normalizeStemBreaks("題幹\n\n\n(1)第一項"),
		"題幹\n(1)第一項",
	);
});

test("逗號結尾也算句中,要接回去", () => {
	assert.equal(
		normalizeStemBreaks("first part,\nsecond part"),
		"first part, second part",
	);
	assert.equal(normalizeStemBreaks("前半，\n後半"), "前半，後半");
});

test("空字串與 undefined 不炸", () => {
	assert.equal(normalizeStemBreaks(""), "");
	assert.equal(normalizeStemBreaks(undefined as unknown as string), "");
});

test("沒有換行的題幹原樣回傳(不動多數題目)", () => {
	const s = "Which of the following statements is correct?";
	assert.equal(normalizeStemBreaks(s), s);
});

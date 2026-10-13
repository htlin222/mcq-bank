import { test } from "node:test";
import assert from "node:assert/strict";
import { acceptInitial, spellingHintUsed } from "./smearHint.ts";

test("拼字提示旗標:沒用不記、只用一個記一個、兩個都用固定成 initial,topic", () => {
	assert.equal(spellingHintUsed({ topic: false, initial: false }), undefined);
	assert.equal(spellingHintUsed({ topic: true, initial: false }), "topic");
	assert.equal(spellingHintUsed({ topic: false, initial: true }), "initial");
	assert.equal(spellingHintUsed({ topic: true, initial: true }), "initial,topic");
});

test("acceptInitial 只收一個字母,整段詞與空字串都不畫", () => {
	assert.equal(acceptInitial("D"), "D");
	assert.equal(acceptInitial("淚"), "淚");
	assert.equal(acceptInitial("Dacrocyte"), null);
	assert.equal(acceptInitial("acute promyelocytic leukemia"), null);
	assert.equal(acceptInitial(""), null);
	assert.equal(acceptInitial("12"), null);
	assert.equal(acceptInitial("!"), null);
});

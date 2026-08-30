import { test } from "node:test";
import assert from "node:assert/strict";
import { resumeIdx } from "./examResume.ts";

const qs = (...chosen: (string | null)[]) =>
	chosen.map((c, i) => ({ id: `q${i}`, chosen: c }));

test("停在第一個沒有 chosen 的題目", () => {
	assert.equal(resumeIdx(qs("A", "B", null, null)), 2);
});

test("全新的一場從第一題開始", () => {
	assert.equal(resumeIdx(qs(null, null, null)), 0);
});

test("全部答完回到第一題(要做的是檢查與交卷)", () => {
	assert.equal(resumeIdx(qs("A", "B", "C")), 0);
});

test("中間跳過的題目算未作答 —— 不是只看最後答到哪", () => {
	assert.equal(resumeIdx(qs("A", null, "C", "D")), 1);
});

test("本機作答也算數(離線時還沒進 chosen)", () => {
	assert.equal(resumeIdx(qs(null, null, null), { q0: "A" }), 1);
});

test("chosen 有、本機沒有,一樣算答過了", () => {
	assert.equal(resumeIdx(qs("A", null), {}), 1);
});

test("空字串不算作答", () => {
	assert.equal(resumeIdx(qs("", null)), 0);
});

test("沒有題目時回 0,不回 -1", () => {
	assert.equal(resumeIdx([]), 0);
});

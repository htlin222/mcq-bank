import { test } from "node:test";
import assert from "node:assert/strict";
import { nextHeadingIndex, nextSlot } from "./headingCursor.ts";

test("第一次按下:往下從頭開始,往上從尾開始", () => {
	assert.equal(nextHeadingIndex(-1, 5, 1), 0);
	assert.equal(nextHeadingIndex(-1, 5, -1), 4);
});

test("一般移動", () => {
	assert.equal(nextHeadingIndex(2, 5, 1), 3);
	assert.equal(nextHeadingIndex(2, 5, -1), 1);
});

test("到底就停住,不繞回開頭 —— 長按時位置被彈走比停住更難用", () => {
	assert.equal(nextHeadingIndex(4, 5, 1), 4);
	assert.equal(nextHeadingIndex(0, 5, -1), 0);
});

test("沒有標題時回 -1", () => {
	assert.equal(nextHeadingIndex(-1, 0, 1), -1);
	assert.equal(nextHeadingIndex(3, 0, -1), -1);
});

test("標題數變少(收合了某個區段)時游標不會指到界外", () => {
	assert.equal(nextHeadingIndex(9, 3, 1), 2);
	assert.equal(nextHeadingIndex(9, 3, -1), 2);
});

test("筆記左右切換會繞圈", () => {
	assert.equal(nextSlot([0, 1, 2], 2, 1), 0);
	assert.equal(nextSlot([0, 1, 2], 0, -1), 2);
	assert.equal(nextSlot([0, 1, 2], 0, 1), 1);
});

test("slot 不必連號(刪掉中間那則之後)", () => {
	assert.equal(nextSlot([0, 3, 7], 3, 1), 7);
	assert.equal(nextSlot([0, 3, 7], 7, 1), 0);
	assert.equal(nextSlot([0, 3, 7], 0, -1), 7);
});

test("只有一則時原地不動,不會看起來像壞掉", () => {
	assert.equal(nextSlot([2], 2, 1), 2);
	assert.equal(nextSlot([2], 2, -1), 2);
});

test("目前的 slot 不在清單裡(剛被刪掉)時退到第一則", () => {
	assert.equal(nextSlot([1, 2], 9, 1), 1);
});

test("完全沒有筆記時原樣回傳,不丟例外", () => {
	assert.equal(nextSlot([], 0, 1), 0);
});

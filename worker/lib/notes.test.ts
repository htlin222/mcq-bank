import { test } from "node:test";
import assert from "node:assert/strict";
import {
	MAX_NOTES_PER_QUESTION,
	parseSlot,
	resolveNoteSlot,
} from "./notes.ts";

test("parseSlot:看不懂的一律退回第一則", () => {
	assert.equal(parseSlot(3), 3);
	assert.equal(parseSlot("3"), 3);
	assert.equal(parseSlot(undefined), 0);
	assert.equal(parseSlot("new"), 0);
	assert.equal(parseSlot(-1), 0);
	assert.equal(parseSlot(1.5), 0);
	assert.equal(parseSlot(MAX_NOTES_PER_QUESTION), 0);
});

test("沒指定 slot → 第一則(最小號碼),與 0.7.x 的 .skill 行為相同", () => {
	assert.deepEqual(resolveNoteSlot([], null), {
		ok: true,
		slot: 0,
		isNew: true,
	});
	assert.deepEqual(resolveNoteSlot([0, 1, 2], null), {
		ok: true,
		slot: 0,
		isNew: false,
	});
	// slot 0 被刪掉時,「第一則」是剩下的最小號碼,不是憑空再開一個 0
	assert.deepEqual(resolveNoteSlot([2, 1], null), {
		ok: true,
		slot: 1,
		isNew: false,
	});
});

test("指定既有的 slot 就寫那則", () => {
	assert.deepEqual(resolveNoteSlot([0, 3], 3), {
		ok: true,
		slot: 3,
		isNew: false,
	});
});

test("指定不存在的 slot 回 404,不在中間開洞", () => {
	const r = resolveNoteSlot([0, 1], 5);
	assert.equal(r.ok, false);
	assert.equal(r.ok === false && r.status, 404);
	assert.deepEqual(r.ok === false && r.slots, [0, 1]);
});

test("一則都沒有時,指定 slot 0 視為建立第一則", () => {
	assert.deepEqual(resolveNoteSlot([], 0), {
		ok: true,
		slot: 0,
		isNew: true,
	});
	// 但指定別的號碼仍是找不到
	assert.equal(resolveNoteSlot([], 2).ok, false);
});

test('"new" 取最大號碼 +1,不重用刪掉的號碼', () => {
	assert.deepEqual(resolveNoteSlot([], "new"), {
		ok: true,
		slot: 0,
		isNew: true,
	});
	// 曾有 0/1/2、刪掉 1 之後 → 下一則是 3,不是補回 1
	assert.deepEqual(resolveNoteSlot([0, 2], "new"), {
		ok: true,
		slot: 3,
		isNew: true,
	});
});

test('"new" 撞到上限回 409', () => {
	const full = Array.from({ length: MAX_NOTES_PER_QUESTION }, (_, i) => i);
	const tooMany = resolveNoteSlot(full, "new");
	assert.equal(tooMany.ok === false && tooMany.status, 409);
	assert.equal(tooMany.ok === false && tooMany.error, "too many notes");

	// 反覆新增/刪除把號碼推到頂:則數沒超標,但下一個號碼超出範圍
	const exhausted = resolveNoteSlot([MAX_NOTES_PER_QUESTION - 1], "new");
	assert.equal(exhausted.ok === false && exhausted.status, 409);
	assert.equal(exhausted.ok === false && exhausted.error, "slot range exhausted");
});

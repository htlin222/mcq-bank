import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveSmearNoteOrder } from "./smear-notes.ts";

const EXISTING = ["n-a", "n-b", "n-c"];

test("完整排列才收,id 原樣留著", () => {
	const r = resolveSmearNoteOrder(EXISTING, ["n-c", "n-a", "n-b"]);
	assert.deepEqual(r, { ok: true, ids: ["n-c", "n-a", "n-b"] });
});

test("放回原位也是合法排列", () => {
	assert.deepEqual(resolveSmearNoteOrder(EXISTING, ["n-a", "n-b", "n-c"]), {
		ok: true,
		ids: ["n-a", "n-b", "n-c"],
	});
});

test("少一個、多一個、重複、未知 id 都整批拒絕", () => {
	assert.equal(resolveSmearNoteOrder(EXISTING, ["n-a", "n-b"]).ok, false);
	assert.equal(resolveSmearNoteOrder(EXISTING, ["n-a", "n-b", "n-c", "n-d"]).ok, false);
	assert.equal(resolveSmearNoteOrder(EXISTING, ["n-a", "n-a", "n-b"]).ok, false);
	assert.equal(resolveSmearNoteOrder(EXISTING, ["n-a", "n-b", "other"]).ok, false);
});

test("不是字串陣列就拒絕,不把數字收成 id", () => {
	assert.equal(resolveSmearNoteOrder(EXISTING, undefined).ok, false);
	assert.equal(resolveSmearNoteOrder(EXISTING, "n-a,n-b,n-c").ok, false);
	assert.equal(resolveSmearNoteOrder(EXISTING, [0, 1, 2]).ok, false);
	assert.equal(resolveSmearNoteOrder(EXISTING, ["n-a", "", "n-c"]).ok, false);
});

test("空清單對空清單", () => {
	assert.deepEqual(resolveSmearNoteOrder([], []), { ok: true, ids: [] });
	assert.equal(resolveSmearNoteOrder([], ["n-a"]).ok, false);
});

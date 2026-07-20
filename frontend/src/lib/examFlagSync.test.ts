import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeFlags } from "./examFlagSync.ts";

test("本機有、server 沒有 → 採本機並列入上推", () => {
	const out = mergeFlags({ a: { flagged: true, t: 10 } }, []);
	assert.equal(out.flags.a.flagged, true);
	assert.deepEqual(out.push, ["a"]);
});

test("server 有、本機沒有 → 採 server,不上推", () => {
	const out = mergeFlags({}, [
		{ question_id: "b", flagged: true, flagged_at: 10 },
	]);
	assert.equal(out.flags.b.flagged, true);
	assert.deepEqual(out.push, []);
});

test("兩邊衝突取較新(server 較新 / 本機較新)", () => {
	const a = mergeFlags({ c: { flagged: false, t: 5 } }, [
		{ question_id: "c", flagged: true, flagged_at: 9 },
	]);
	assert.equal(a.flags.c.flagged, true);
	assert.deepEqual(a.push, []);

	const b = mergeFlags({ c: { flagged: true, t: 20 } }, [
		{ question_id: "c", flagged: false, flagged_at: 9 },
	]);
	assert.equal(b.flags.c.flagged, true);
	assert.deepEqual(b.push, ["c"]);
});

test("時間戳相同 → 以 server 為準且不上推(避免無限互推)", () => {
	const out = mergeFlags({ d: { flagged: true, t: 7 } }, [
		{ question_id: "d", flagged: false, flagged_at: 7 },
	]);
	assert.equal(out.flags.d.flagged, false);
	assert.deepEqual(out.push, []);
});

test("舊本機資料缺 t → 視為 0,server 任何值都較新", () => {
	const out = mergeFlags({ e: { flagged: true } }, [
		{ question_id: "e", flagged: false, flagged_at: 1 },
	]);
	assert.equal(out.flags.e.flagged, false);
	assert.deepEqual(out.push, []);
});

test("server 列缺 flagged_at(舊列)→ 視為 0,本機較新就上推", () => {
	const out = mergeFlags({ g: { flagged: true, t: 3 } }, [
		{ question_id: "g", flagged: false, flagged_at: null },
	]);
	assert.equal(out.flags.g.flagged, true);
	assert.deepEqual(out.push, ["g"]);
});

test("本機獨有但為 false → 不上推(預設值沒有資訊量)", () => {
	assert.deepEqual(mergeFlags({ f: { flagged: false, t: 3 } }, []).push, []);
});

test("多題:合併兩邊聯集,push 依 question_id 排序", () => {
	const out = mergeFlags(
		{
			a: { flagged: true, t: 100 },
			b: { flagged: true, t: 1 },
			z: { flagged: true, t: 100 },
		},
		[
			{ question_id: "b", flagged: false, flagged_at: 50 },
			{ question_id: "c", flagged: true, flagged_at: 50 },
		],
	);
	assert.deepEqual(Object.keys(out.flags).sort(), ["a", "b", "c", "z"]);
	assert.equal(out.flags.b.flagged, false); // server 較新
	assert.equal(out.flags.c.flagged, true);
	assert.deepEqual(out.push, ["a", "z"]);
});

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { prefKey, wasAutoCloze, rememberAutoCloze } from "./clozePref.ts";

// node:test has no DOM — a tiny in-memory localStorage is enough, since the
// module only ever does getItem/setItem.
const store = new Map<string, string>();
(globalThis as any).localStorage = {
	getItem: (k: string) => store.get(k) ?? null,
	setItem: (k: string, v: string) => void store.set(k, v),
};

beforeEach(() => store.clear());

test("題號與區塊各自獨立 —— 詳解開了不代表筆記也開", () => {
	rememberAutoCloze("114-052", "note", true);
	assert.equal(wasAutoCloze("114-052", "note"), true);
	assert.equal(wasAutoCloze("114-052", "explanation"), false);
	assert.equal(wasAutoCloze("114-053", "note"), false);
});

test("關掉就要真的忘掉,不能下次又自己冒出來", () => {
	rememberAutoCloze("114-052", "note", true);
	rememberAutoCloze("114-052", "note", false);
	assert.equal(wasAutoCloze("114-052", "note"), false);
});

test("重複記憶不會累積重複項", () => {
	rememberAutoCloze("114-052", "note", true);
	rememberAutoCloze("114-052", "note", true);
	assert.deepEqual(JSON.parse(store.get("cloze:auto:v1")!), ["114-052|note"]);
});

test("壞掉或非陣列的 localStorage 內容視為沒有記憶,不拋錯", () => {
	store.set("cloze:auto:v1", "{oops");
	assert.equal(wasAutoCloze("114-052", "note"), false);
	store.set("cloze:auto:v1", '{"a":1}');
	assert.equal(wasAutoCloze("114-052", "note"), false);
	store.set("cloze:auto:v1", '["114-052|note", 42, null]');
	assert.equal(wasAutoCloze("114-052", "note"), true);
});

test("prefKey 同時含題號與區塊", () => {
	assert.equal(prefKey("114-052", "explanation"), "114-052|explanation");
});

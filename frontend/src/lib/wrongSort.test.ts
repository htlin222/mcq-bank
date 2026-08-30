import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_WRONG_SORT, WRONG_SORT_LABELS } from "./wrongSort.ts";

// 兩份清單分屬前後端,鍵一旦漂移就是「選了沒反應」——沒有錯誤訊息的那種。
// 讀原始碼而不是 import:worker 那支是 D1 專用的模組,不該被前端 bundle 進來。
const WORKER_SRC = path.join(
	path.dirname(new URL(import.meta.url).pathname),
	"..",
	"..",
	"..",
	"worker",
	"lib",
	"wrong-sort.ts",
);

test("前後端的排序鍵完全一致", () => {
	const src = fs.readFileSync(WORKER_SRC, "utf8");
	const m = /export const WRONG_SORTS = \[([^\]]+)\]/.exec(src);
	assert.ok(m, "worker/lib/wrong-sort.ts 的 WRONG_SORTS 找不到 —— 這條防線失效了");
	const server = m[1]
		.split(",")
		.map((s) => s.trim().replace(/^"|"$/g, ""))
		.filter(Boolean);
	assert.deepEqual(
		[...Object.keys(WRONG_SORT_LABELS)].sort(),
		[...server].sort(),
	);
});

test("預設值兩邊一樣", () => {
	const src = fs.readFileSync(WORKER_SRC, "utf8");
	const m = /DEFAULT_WRONG_SORT: WrongSort = "([^"]+)"/.exec(src);
	assert.ok(m, "找不到 worker 那側的預設值");
	assert.equal(DEFAULT_WRONG_SORT, m[1]);
});

test("每一項都有給人看的字,而且互不相同", () => {
	const labels = Object.values(WRONG_SORT_LABELS);
	assert.ok(labels.every((l) => l.length > 0));
	assert.equal(new Set(labels).size, labels.length);
});

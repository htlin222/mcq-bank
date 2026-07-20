import { test } from "node:test";
import assert from "node:assert/strict";
import {
	D1_MAX_PARAMS,
	MAX_TAG_FILTERS,
	chunkParams,
	parseTagList,
} from "./sql-params.ts";

test("短清單不分批,長清單切到不超過上限", () => {
	assert.deepEqual(chunkParams([1, 2, 3], 5), [[1, 2, 3]]);
	assert.deepEqual(chunkParams([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
	assert.equal(chunkParams(Array(200).fill(0)).every((c) => c.length <= D1_MAX_PARAMS), true);
});

test("chunkParams 的 size 不合法時退回每批 1 個,不會無限迴圈", () => {
	assert.deepEqual(chunkParams([1, 2], 0), [[1], [2]]);
	assert.deepEqual(chunkParams([1, 2], -5), [[1], [2]]);
});

test("空輸入回空陣列,不會產生空的 IN ()", () => {
	assert.deepEqual(parseTagList(undefined), []);
	assert.deepEqual(parseTagList(""), []);
	assert.deepEqual(parseTagList(" , , "), []);
});

test("去頭尾空白、去重,順序保留", () => {
	assert.deepEqual(parseTagList(" CML , ALL,CML , AML "), ["CML", "ALL", "AML"]);
});

test("超過上限就截斷 —— 這是防 D1 too many SQL variables 的關鍵", () => {
	const many = Array.from({ length: 300 }, (_, i) => `t${i}`).join(",");
	assert.equal(parseTagList(many).length, MAX_TAG_FILTERS);
});

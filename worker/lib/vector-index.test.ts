import { test } from "node:test";
import assert from "node:assert/strict";
import { semanticIndexEmpty } from "./vector-index.ts";

test("索引不存在或 0 筆都算尚未回填", () => {
	assert.equal(semanticIndexEmpty(null), true);
	assert.equal(semanticIndexEmpty(undefined), true);
	assert.equal(semanticIndexEmpty({}), true);
	assert.equal(semanticIndexEmpty({ vectorCount: 0 }), true);
	assert.equal(semanticIndexEmpty({ vectorCount: -1 }), true);
	assert.equal(semanticIndexEmpty({ vectorCount: Number.NaN }), true);
});

test("有向量就不算空", () => {
	assert.equal(semanticIndexEmpty({ vectorCount: 1 }), false);
	assert.equal(semanticIndexEmpty({ vectorCount: 1100 }), false);
	// beta describe() 的欄位名。
	assert.equal(semanticIndexEmpty({ vectorsCount: 0 }), true);
	assert.equal(semanticIndexEmpty({ vectorsCount: 12 }), false);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { readSimilarPayload, SEMANTIC_INDEX_EMPTY } from "./similarPayload.ts";

test("新舊兩種回應都收成清單", () => {
	assert.deepEqual(readSimilarPayload([{ id: "113-001" }]), {
		items: [{ id: "113-001" }],
		indexEmpty: false,
	});
	assert.deepEqual(
		readSimilarPayload({ items: [{ id: "113-002" }], index_empty: true }),
		{ items: [{ id: "113-002" }], indexEmpty: true },
	);
	assert.deepEqual(readSimilarPayload({}), { items: [], indexEmpty: false });
	assert.deepEqual(readSimilarPayload(null), { items: [], indexEmpty: false });
	assert.equal(SEMANTIC_INDEX_EMPTY, "語意索引尚未回填");
});

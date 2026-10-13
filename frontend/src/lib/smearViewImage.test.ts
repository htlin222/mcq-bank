import { test } from "node:test";
import assert from "node:assert/strict";
import { smearViewPixelSize, viewIsClearlySmaller } from "./smearViewImage.ts";

test("剛好 80% 算明顯更小,多一個 byte 不行", () => {
	assert.equal(viewIsClearlySmaller(800, 1000), true);
	assert.equal(viewIsClearlySmaller(801, 1000), false);
	assert.equal(viewIsClearlySmaller(0, 1000), false);
	assert.equal(viewIsClearlySmaller(100, 0), false);
});

test("長邊超過 1280 收到 1280,否則收到 75%", () => {
	assert.deepEqual(smearViewPixelSize(2400, 1800), { width: 1280, height: 960 });
	assert.deepEqual(smearViewPixelSize(100, 4000), { width: 32, height: 1280 });
	assert.deepEqual(smearViewPixelSize(800, 600), { width: 600, height: 450 });
	assert.deepEqual(smearViewPixelSize(1280, 720), { width: 960, height: 540 });
	assert.deepEqual(smearViewPixelSize(1, 1), { width: 1, height: 1 });
	assert.equal(smearViewPixelSize(0, 10), null);
	assert.equal(smearViewPixelSize(-4, 10), null);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import {
	planApprovedImages,
	submissionViewKey,
	viewIsClearlySmaller,
} from "./smear-approve-images.ts";

test("剛好 80% 算明顯更小,多一個 byte 不行", () => {
	assert.equal(viewIsClearlySmaller(800, 1000), true);
	assert.equal(viewIsClearlySmaller(801, 1000), false);
	assert.equal(viewIsClearlySmaller(0, 1000), false);
	assert.equal(viewIsClearlySmaller(100, 0), false);
	assert.equal(viewIsClearlySmaller(Number.NaN, 1000), false);
});

test("檢視圖 key 跟原檔不同,而且帶得上內容類型", () => {
	assert.equal(
		submissionViewKey("sub-1", "image/jpeg"),
		"smear/submissions/sub-1-view.jpg",
	);
	assert.equal(submissionViewKey("sub-1", "image/png"), "smear/submissions/sub-1-view.png");
	assert.equal(submissionViewKey("sub-1", "image/webp"), "smear/submissions/sub-1-view.webp");
	assert.equal(submissionViewKey("../sub-1", "image/jpeg"), null);
	assert.equal(submissionViewKey("a/b", "image/jpeg"), null);
	assert.equal(submissionViewKey("sub-1", "image/svg+xml"), null);
	assert.equal(submissionViewKey("", "image/jpeg"), null);
});

test("核准計畫寫出兩把不同的 key,檢視圖不夠小就整筆拒絕", () => {
	const ok = planApprovedImages({
		submissionId: "sub-1",
		fullKey: "smear/submissions/original.jpg",
		viewType: "image/jpeg",
		viewBytes: 400_000,
		fullBytes: 1_200_000,
	});
	assert.equal(ok.ok, true);
	if (ok.ok) {
		assert.notEqual(ok.viewKey, ok.fullKey);
		assert.equal(ok.fullKey, "smear/submissions/original.jpg");
		assert.equal(ok.viewKey, "smear/submissions/sub-1-view.jpg");
	}

	const big = planApprovedImages({
		submissionId: "sub-1",
		fullKey: "smear/submissions/original.jpg",
		viewType: "image/jpeg",
		viewBytes: 900,
		fullBytes: 1000,
	});
	assert.deepEqual(big, {
		ok: false,
		error: "view image must be clearly smaller than the original",
	});

	const collide = planApprovedImages({
		submissionId: "sub-1",
		fullKey: "smear/submissions/sub-1-view.jpg",
		viewType: "image/jpeg",
		viewBytes: 100,
		fullBytes: 1000,
	});
	assert.equal(collide.ok, false);
});

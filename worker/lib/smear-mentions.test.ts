import { test } from "node:test";
import assert from "node:assert/strict";
import {
	DELETED_SMEAR_COMMENT_PREVIEW,
	smearCommentPreview,
	smearMentionTargets,
} from "./smear-mentions.ts";

const SECRET = "這句原文不該在刪除後留下";

function doc(content: unknown[]): string {
	return JSON.stringify({ type: "doc", content });
}

const mention = (id: string) => ({
	type: "mention",
	attrs: { id, label: id },
});

test("只通知名單內、不是作者自己的 mention 節點", () => {
	const json = doc([
		{
			type: "paragraph",
			content: [
				mention("known@example.com"),
				mention("self@example.com"),
				mention("ghost@example.com"),
				mention("known@example.com"),
				{ type: "text", text: " 也寫了 ghost@example.com 但這不是 mention 節點" },
			],
		},
	]);
	const got = smearMentionTargets(
		json,
		"self@example.com",
		new Set(["known@example.com", "self@example.com"]),
	);
	assert.deepEqual(got, ["known@example.com"]);
});

test("純文字裡的 @ 不產生通知", () => {
	const json = doc([
		{
			type: "paragraph",
			content: [{ type: "text", text: "@known@example.com 看看" }],
		},
	]);
	assert.deepEqual(
		smearMentionTargets(json, "author@example.com", new Set(["known@example.com"])),
		[],
	);
});

test("預覽取內文,刪除後的預覽是固定墓碑、不含原文", () => {
	const json = doc([
		{
			type: "paragraph",
			content: [{ type: "text", text: SECRET }, mention("known@example.com")],
		},
	]);
	assert.ok(smearCommentPreview(json).includes(SECRET));
	assert.equal(DELETED_SMEAR_COMMENT_PREVIEW, "留言已刪除");
	assert.ok(!DELETED_SMEAR_COMMENT_PREVIEW.includes(SECRET));
});

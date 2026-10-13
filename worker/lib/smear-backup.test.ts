import { test } from "node:test";
import assert from "node:assert/strict";
import { smearAnswerCursor } from "./smear-backup.ts";

test("同一場的下一題游標比這一題大,所以分頁不會停住也不會把後半丟掉", () => {
	const first = smearAnswerCursor("sess-1", "q-a");
	const second = smearAnswerCursor("sess-1", "q-b");
	assert.notEqual(first, second);
	assert.ok(second > first);
	assert.ok(first > "");
	// 下一場整段都在這一場之後,不會被這一場的游標吞掉。
	assert.ok(smearAnswerCursor("sess-2", "q-a") > second);
});

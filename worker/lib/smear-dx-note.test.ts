import { test } from "node:test";
import assert from "node:assert/strict";
import {
	SMEAR_NOTE_LOCK_MS,
	SMEAR_NOTE_LOCK_SQL,
	SMEAR_NOTE_SAVE_SQL,
	parseSmearNoteSaveBody,
	smearNoteLockBinds,
	smearNoteLockDecision,
	smearNoteSaveBinds,
	smearNoteSaveRefusal,
} from "./smear-dx-note.ts";

const NOW = 1_700_000_000_000;

test("沒有詳解列不能鎖", () => {
	assert.equal(smearNoteLockDecision(null, "a@x", NOW).action, "missing");
});

test("空鎖、過期鎖、自己的鎖都可以取得;別人未過期的鎖不行", () => {
	assert.equal(
		smearNoteLockDecision({ editing_by: null, editing_until: null }, "a@x", NOW).action,
		"grant",
	);
	const expired = smearNoteLockDecision(
		{ editing_by: "b@x", editing_until: NOW },
		"a@x",
		NOW,
	);
	assert.equal(expired.action, "grant");
	if (expired.action === "grant") assert.equal(expired.until, NOW + SMEAR_NOTE_LOCK_MS);

	const mine = smearNoteLockDecision(
		{ editing_by: "a@x", editing_until: NOW + 1000 },
		"a@x",
		NOW,
	);
	assert.equal(mine.action, "grant");

	const other = smearNoteLockDecision(
		{ editing_by: "b@x", editing_until: NOW + 1000 },
		"a@x",
		NOW,
	);
	assert.deepEqual(other, { action: "deny", lockedBy: "b@x", until: NOW + 1000 });
});

test("鎖的更新把同一個人放在 SET 與 WHERE,過期判斷用 now", () => {
	assert.match(SMEAR_NOTE_LOCK_SQL, /editing_by IS NULL OR editing_by = \?/);
	assert.deepEqual(smearNoteLockBinds("a@x", NOW + 10, "dacrocyte", NOW), [
		"a@x",
		NOW + 10,
		"dacrocyte",
		"a@x",
		NOW,
	]);
});

test("沒寫入時:別人持鎖是 423,自己鎖過期也是 423,版本不合是 409", () => {
	assert.equal(smearNoteSaveRefusal(null, "a@x", 1, NOW).status, 404);
	const other = smearNoteSaveRefusal(
		{ editing_by: "b@x", editing_until: NOW + 50, version: 3 },
		"a@x",
		3,
		NOW,
	);
	assert.equal(other.status, 423);
	if (other.status === 423 && other.error === "locked") assert.equal(other.lockedBy, "b@x");

	const expired = smearNoteSaveRefusal(
		{ editing_by: "a@x", editing_until: NOW - 1, version: 3 },
		"a@x",
		3,
		NOW,
	);
	assert.deepEqual(expired, { status: 423, error: "you do not hold the lock" });

	const clash = smearNoteSaveRefusal(
		{ editing_by: "a@x", editing_until: NOW, version: 4 },
		"a@x",
		3,
		NOW,
	);
	assert.deepEqual(clash, { status: 409, error: "version conflict", serverVersion: 4 });
});

test("存檔綁定把 updated_by 與持鎖的人放在同一個 email,版本是預期值", () => {
	assert.match(SMEAR_NOTE_SAVE_SQL, /updated_by = \?/);
	assert.match(SMEAR_NOTE_SAVE_SQL, /editing_until >= \?/);
	assert.deepEqual(smearNoteSaveBinds('{"type":"doc"}', "a@x", NOW, "dacrocyte", 2), [
		'{"type":"doc"}',
		"a@x",
		NOW,
		"dacrocyte",
		2,
		"a@x",
		NOW,
	]);
});

test("存檔本文必須是文件物件,版本必須是整數", () => {
	const doc = { type: "doc", content: [] };
	assert.deepEqual(parseSmearNoteSaveBody({ content_json: doc, expected_version: 1 }), {
		ok: true,
		json: JSON.stringify(doc),
		expectedVersion: 1,
	});
	assert.equal(parseSmearNoteSaveBody({ expected_version: 1 }).ok, false);
	assert.equal(parseSmearNoteSaveBody({ content_json: doc, expected_version: 1.5 }).ok, false);
	assert.equal(parseSmearNoteSaveBody({ content_json: "nope", expected_version: 1 }).ok, false);
});

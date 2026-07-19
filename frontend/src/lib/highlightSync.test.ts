import { test } from "node:test";
import assert from "node:assert/strict";
import { pickHighlight } from "./highlightSync.ts";

const H = "hash-A";

test("兩邊都沒有(或都對不上 hash)→ none", () => {
	assert.deepEqual(pickHighlight(null, null, H), { source: "none" });
	assert.deepEqual(
		pickHighlight({ h: "old", doc: {}, t: 5 }, { content_hash: "old2", doc_json: "{}", updated_at: 9 }, H),
		{ source: "none" },
	);
});

test("只有 local 有效 → 用 local 並推上 server", () => {
	assert.deepEqual(
		pickHighlight({ h: H, doc: {}, t: 5 }, null, H),
		{ source: "local", pushToServer: true },
	);
});

test("只有 server 有效 → 用 server,不回推", () => {
	assert.deepEqual(
		pickHighlight(null, { content_hash: H, doc_json: "{}", updated_at: 9 }, H),
		{ source: "server" },
	);
});

test("兩邊都有效:local 較新 → local 並回推", () => {
	assert.deepEqual(
		pickHighlight({ h: H, doc: {}, t: 20 }, { content_hash: H, doc_json: "{}", updated_at: 9 }, H),
		{ source: "local", pushToServer: true },
	);
});

test("兩邊都有效:server 較新 → server", () => {
	assert.deepEqual(
		pickHighlight({ h: H, doc: {}, t: 5 }, { content_hash: H, doc_json: "{}", updated_at: 30 }, H),
		{ source: "server" },
	);
});

test("兩邊都有效且時間相同 → local,不回推(避免無謂寫入)", () => {
	assert.deepEqual(
		pickHighlight({ h: H, doc: {}, t: 10 }, { content_hash: H, doc_json: "{}", updated_at: 10 }, H),
		{ source: "local", pushToServer: false },
	);
});

test("legacy local(t 缺)輸給有時間戳的 server", () => {
	assert.deepEqual(
		pickHighlight({ h: H, doc: {} } as never, { content_hash: H, doc_json: "{}", updated_at: 3 }, H),
		{ source: "server" },
	);
});

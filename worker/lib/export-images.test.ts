import { test } from "node:test";
import assert from "node:assert/strict";
import { collectImageKeys, planEmbed, fetchEmbeds } from "./export-images.ts";
import type { ExportItem } from "./export-doc.ts";

const item = (over: Partial<ExportItem>): ExportItem => ({
	id: "114-001",
	year: 114,
	number: 1,
	group: null,
	stem: "s",
	options: [],
	answer: "A",
	tags: [],
	explanation: null,
	note: null,
	highlights: [],
	...over,
});

const imgDoc = (...srcs: string[]) => ({
	type: "doc",
	content: srcs.map((src) => ({ type: "image", attrs: { src } })),
});

test("collectImageKeys:走出 /img/<key>,去重、排除外連、拒 ..", () => {
	const items = [
		item({ explanation: imgDoc("/img/years/114/a.png", "https://x.test/b.png") }),
		item({ note: imgDoc("/img/years/114/a.png", "/img/c.png") }),
		item({ explanation: imgDoc("/img/../../etc/passwd", "/img/x/../y.png") }),
	];
	assert.deepEqual(collectImageKeys(items), ["years/114/a.png", "c.png"]);
});

test("collectImageKeys:巢狀節點裡的圖片也找得到", () => {
	const nested = {
		type: "doc",
		content: [
			{
				type: "bulletList",
				content: [
					{
						type: "listItem",
						content: [
							{ type: "paragraph", content: [{ type: "image", attrs: { src: "/img/n.png" } }] },
						],
					},
				],
			},
		],
	};
	assert.deepEqual(collectImageKeys([item({ explanation: nested })]), ["n.png"]);
});

test("collectImageKeys:沒有圖片 / doc 為 null → 空陣列", () => {
	assert.deepEqual(collectImageKeys([item({})]), []);
	assert.deepEqual(collectImageKeys([]), []);
});

test("planEmbed:超過張數上限的丟進 skipped,順序保留", () => {
	const keys = Array.from({ length: 25 }, (_, i) => `k${i}.png`);
	const { embed, skipped } = planEmbed(keys, { maxCount: 20 });
	assert.equal(embed.length, 20);
	assert.equal(skipped.length, 5);
	assert.equal(embed[0], "k0.png");
	assert.equal(skipped[0], "k20.png");
	assert.deepEqual(planEmbed(["a"], { maxCount: 20 }).skipped, []);
});

// -------------------------------------------------------------- fetchEmbeds

function fakeR2(sizes: Record<string, number>, type = "image/png") {
	return {
		async get(key: string) {
			const n = sizes[key];
			if (n === undefined) return null;
			return {
				httpMetadata: { contentType: type },
				async arrayBuffer() {
					return new Uint8Array(n).fill(65).buffer;
				},
			};
		},
	} as any;
}

test("fetchEmbeds:回傳以 /img/<key> 為索引的 data: URI", async () => {
	const map = await fetchEmbeds(fakeR2({ "a.png": 3 }), ["a.png"]);
	assert.equal(map.get("/img/a.png"), "data:image/png;base64,QUFB");
});

test("fetchEmbeds:累計超過 maxBytes 就停,其餘不內嵌", async () => {
	const map = await fetchEmbeds(fakeR2({ "a.png": 600, "b.png": 600, "c.png": 600 }), [
		"a.png",
		"b.png",
		"c.png",
	], { maxBytes: 1000, concurrency: 1 });
	assert.equal(map.size, 1);
	assert.ok(map.has("/img/a.png"));
});

test("fetchEmbeds:R2 找不到的 key 靜默略過,不丟例外", async () => {
	const map = await fetchEmbeds(fakeR2({ "a.png": 2 }), ["a.png", "missing.png"]);
	assert.equal(map.size, 1);
});

test("fetchEmbeds:contentType 缺失時退回 application/octet-stream", async () => {
	const r2 = {
		async get() {
			return { httpMetadata: {}, async arrayBuffer() { return new Uint8Array(1).buffer; } };
		},
	} as any;
	const map = await fetchEmbeds(r2, ["a.png"]);
	assert.ok(map.get("/img/a.png")!.startsWith("data:application/octet-stream;base64,"));
});

test("fetchEmbeds:空清單 → 空 Map,不呼叫 R2", async () => {
	let called = false;
	const r2 = { async get() { called = true; return null; } } as any;
	assert.equal((await fetchEmbeds(r2, [])).size, 0);
	assert.equal(called, false);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import {
	AVG_IMAGE_BYTES,
	collectImageSrcs,
	describeImageCost,
	hasRoomFor,
	imagesInQuestionPayload,
} from "./offlineImages.ts";

const img = (src: string) => ({ type: "image", attrs: { src } });
const doc = (...content: unknown[]) => ({ type: "doc", content });

test("撈得到巢狀在段落裡的站內圖", () => {
	const d = doc(
		{ type: "paragraph", content: [{ type: "text", text: "hi" }] },
		img("/img/years/113/a.webp"),
		{ type: "blockquote", content: [img("/img/years/113/b.webp")] },
	);
	assert.deepEqual(collectImageSrcs(d), [
		"/img/years/113/a.webp",
		"/img/years/113/b.webp",
	]);
});

test("同一張圖只算一次", () => {
	const d = doc(img("/img/x.webp"), img("/img/x.webp"));
	assert.deepEqual(collectImageSrcs(d), ["/img/x.webp"]);
});

test("外部圖片不收 —— 它們不經過我們的 Worker,抓了也不會進 img-v1", () => {
	const d = doc(img("https://example.com/a.png"), img("/img/ours.webp"));
	assert.deepEqual(collectImageSrcs(d), ["/img/ours.webp"]);
});

test("帶 .. 的路徑一律拒絕(content_json 是使用者可寫的欄位)", () => {
	const d = doc(img("/img/../../etc/passwd"), img("/img/ok.webp"));
	assert.deepEqual(collectImageSrcs(d), ["/img/ok.webp"]);
});

test("空的 / 壞掉的輸入不丟例外", () => {
	assert.deepEqual(collectImageSrcs(null), []);
	assert.deepEqual(collectImageSrcs({}), []);
	assert.deepEqual(collectImageSrcs({ type: "image" }), []); // 沒有 attrs
	assert.deepEqual(collectImageSrcs({ type: "image", attrs: {} }), []);
});

// —— 從題目 payload 撈 ————————————————————————————————————————

test("只看共筆詳解,不看個人筆記", () => {
	const payload = {
		id: "113-001",
		explanation: { content_json: JSON.stringify(doc(img("/img/exp.webp"))) },
		my_note: { content_json: JSON.stringify(doc(img("/img/note.webp"))) },
		my_notes: [{ content_json: JSON.stringify(doc(img("/img/note2.webp"))) }],
	};
	assert.deepEqual(imagesInQuestionPayload(payload), ["/img/exp.webp"]);
});

test("沒有詳解的題目回空陣列", () => {
	assert.deepEqual(imagesInQuestionPayload({ id: "113-002" }), []);
	assert.deepEqual(imagesInQuestionPayload({ explanation: null }), []);
});

test("壞掉的 content_json 不讓整批停下來", () => {
	assert.deepEqual(
		imagesInQuestionPayload({ explanation: { content_json: "{ not json" } }),
		[],
	);
});

// —— 按鈕上那句話 ————————————————————————————————————————————

test("成本描述帶得出張數與 MB", () => {
	const s = describeImageCost(148);
	assert.match(s, /148 張/);
	// 148 × 66 KB ≈ 9.3 MB
	assert.match(s, /9\.3 MB/);
});

test("小量不會顯示成「約 0 MB」", () => {
	// 整數會讓 4 張顯示成 0 MB,看起來像壞掉。
	assert.match(describeImageCost(4), /0\.3 MB/);
});

test("平均值是量出來的,不是隨手挑的", () => {
	// 2026-08-27 從 R2 抽 10 張,18.7 KB – 147 KB,平均 66 KB。這條在有人「順手
	// 調整」這個常數時會紅,逼他回去重新抽樣 —— 按鈕上的數字是使用者決定要不要
	// 在行動網路上按下去的依據。
	assert.ok(
		AVG_IMAGE_BYTES >= 40_000 && AVG_IMAGE_BYTES <= 100_000,
		`平均值離實測太遠(${AVG_IMAGE_BYTES}),請重新抽樣`,
	);
});

// —— 空間 ——————————————————————————————————————————————————

test("拿不到配額資訊時一律放行", () => {
	assert.equal(hasRoomFor(200, null), true);
	assert.equal(hasRoomFor(200, {}), true);
});

test("空間充足就放行,不足就擋", () => {
	const need = 200 * AVG_IMAGE_BYTES;
	assert.equal(hasRoomFor(200, { usage: 0, quota: need * 4 }), true);
	assert.equal(hasRoomFor(200, { usage: 0, quota: need * 2 }), false);
});

test("已用掉的空間要算進去", () => {
	const need = 200 * AVG_IMAGE_BYTES;
	// 配額看起來很大,但幾乎用光了 —— 不能只看 quota。
	assert.equal(
		hasRoomFor(200, { usage: need * 9, quota: need * 10 }),
		false,
	);
});

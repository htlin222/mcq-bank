import assert from "node:assert/strict";
import { test } from "node:test";
import {
	cardFilename,
	deliveryDoneLabel,
	deliveryLabel,
	pickDelivery,
} from "./shareCard.ts";

const env = (o: Partial<Parameters<typeof pickDelivery>[0]>) => ({
	coarsePointer: false,
	canShareFiles: false,
	canWriteImage: false,
	...o,
});

test("桌機有剪貼簿就用剪貼簿", () => {
	assert.equal(pickDelivery(env({ canWriteImage: true })), "clipboard");
});

test("手機優先走系統分享,即使剪貼簿也可用", () => {
	// Android Chrome 兩者都有 —— 分享才是手機上的自然動作。
	assert.equal(
		pickDelivery(env({ coarsePointer: true, canShareFiles: true, canWriteImage: true })),
		"share",
	);
});

test("桌機沒有剪貼簿權限但能分享時,分享勝過下載", () => {
	assert.equal(pickDelivery(env({ canShareFiles: true })), "share");
});

test("都不支援就下載", () => {
	assert.equal(pickDelivery(env({})), "download");
});

test("觸控但不能分享 —— 退回剪貼簿而不是下載", () => {
	assert.equal(
		pickDelivery(env({ coarsePointer: true, canWriteImage: true })),
		"clipboard",
	);
});

test("按鈕文案跟著實際會發生的事走", () => {
	// 說「複製」卻跳出下載,使用者會以為壞了。
	assert.notEqual(deliveryLabel("download"), deliveryLabel("clipboard"));
	assert.notEqual(deliveryLabel("share"), deliveryLabel("clipboard"));
	for (const d of ["clipboard", "share", "download"] as const) {
		assert.ok(deliveryLabel(d).length > 0);
		assert.ok(deliveryDoneLabel(d).length > 0);
	}
});

test("檔名帶題號與時間,且不含檔案系統會嫌的字元", () => {
	const name = cardFilename("民國 114 年 · 第 32 題", "2026-08-21 11:32");
	assert.match(name, /\.png$/);
	assert.ok(name.includes("114"), name);
	assert.ok(name.includes("20260821"), name);
	assert.ok(!/[\\/:*?"<>|·\s]/.test(name), `檔名含不合法字元: ${name}`);
});

test("出處為空時仍產生合法檔名", () => {
	const name = cardFilename("", "2026-08-21 11:32");
	assert.match(name, /^card-\d+\.png$/);
});

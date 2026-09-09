import { test } from "node:test";
import assert from "node:assert/strict";
import {
	advance,
	retreat,
	initialGallery,
	receivePrefetch,
	shouldAutoAdvance,
	shouldPrefetch,
	secondsLeft,
	AUTO_ADVANCE_MS,
	PREFETCH_LEAD,
	type AutoAdvanceGate,
	type GalleryState,
} from "./smearGallery.ts";

const batchOf = (n: number, prefix = "a") =>
	Array.from({ length: n }, (_, i) => `${prefix}${i}`);

// --- advance / retreat -----------------------------------------------------

test("advance walks the batch one at a time", () => {
	let s = initialGallery(batchOf(3));
	assert.equal(s.index, 0);
	s = advance(s);
	assert.equal(s.index, 1);
	s = advance(s);
	assert.equal(s.index, 2);
});

test("at the end of a batch, advance swaps in the prefetched one", () => {
	let s = receivePrefetch(
		{ batch: batchOf(2, "a"), index: 1, next: null },
		batchOf(2, "b"),
	);
	s = advance(s);
	assert.deepEqual(s.batch, ["b0", "b1"]);
	assert.equal(s.index, 0);
	assert.equal(s.next, null, "接上之後要把 next 清掉,否則下一輪會重播同一批");
});

test("at the end with nothing prefetched it stays put — it does NOT loop back", () => {
	// 回頭重播看起來就像「同一批圖一直循環」,而使用者無從分辨那是設計還是
	// 壞掉。原地不動至少只是「停住了」,下一批一到就自己接上。
	const s = { batch: batchOf(3), index: 2, next: null };
	assert.deepEqual(advance(s), s);
});

test("advance on an empty batch is a no-op", () => {
	const s = initialGallery<string>([]);
	assert.deepEqual(advance(s), s);
});

test("retreat stops at the first item and never crosses back into an old batch", () => {
	let s: GalleryState<string> = { batch: batchOf(3), index: 2, next: null };
	s = retreat(s);
	assert.equal(s.index, 1);
	s = retreat(s);
	assert.equal(s.index, 0);
	// 上一批已經丟掉了,退不回去
	assert.deepEqual(retreat(s), s);
});

// --- prefetch --------------------------------------------------------------

test("prefetch fires only inside the last PREFETCH_LEAD slots", () => {
	const batch = batchOf(24);
	const at = (index: number) => shouldPrefetch({ batch, index, next: null });
	assert.equal(at(0), false);
	assert.equal(at(24 - PREFETCH_LEAD - 1), false);
	assert.equal(at(24 - PREFETCH_LEAD), true, "剩 4 張就該去要下一批");
	assert.equal(at(23), true);
});

test("prefetch does not fire twice for the same batch", () => {
	const s = { batch: batchOf(24), index: 23, next: batchOf(24, "b") };
	assert.equal(shouldPrefetch(s), false);
});

test("prefetch does not fire before the first batch has arrived", () => {
	assert.equal(shouldPrefetch(initialGallery<string>([])), false);
});

test("an empty prefetch result is rejected", () => {
	// 收了會讓 advance 以為接得上,然後換到一個沒有東西的批次上,畫面整個空掉。
	const s = { batch: batchOf(3), index: 2, next: null };
	assert.deepEqual(receivePrefetch(s, []), s);
});

// --- the auto-advance gate -------------------------------------------------

const open: AutoAdvanceGate = {
	paused: false,
	eink: false,
	documentHidden: false,
	interacting: false,
	hasItems: true,
};

test("with every gate open it advances", () => {
	assert.equal(shouldAutoAdvance(open), true);
});

test("each gate on its own is enough to stop it", () => {
	for (const key of [
		"paused",
		"eink",
		"documentHidden",
		"interacting",
	] as const) {
		assert.equal(
			shouldAutoAdvance({ ...open, [key]: true }),
			false,
			`${key} 沒有擋住自動輪播`,
		);
	}
	assert.equal(shouldAutoAdvance({ ...open, hasItems: false }), false);
});

test("間隔要長到讀得完一段說明", () => {
	// 守著這個常數本身。全螢幕畫的是共筆詳解全文(平均 1363 字),調短會讓那段
	// 說明變成一閃而過的裝飾 —— 而讀到一半被換走比等久一點難受得多。
	assert.ok(AUTO_ADVANCE_MS >= 15_000, `間隔太短:${AUTO_ADVANCE_MS}ms`);
});

// --- 倒數 ------------------------------------------------------------------

test("倒數從整數的間隔秒數開始,而不是少一秒", () => {
	// floor 的話一設好就顯示 19,二十秒的倒數看起來像少了一秒。
	const t0 = 1_000_000;
	assert.equal(secondsLeft(t0 + AUTO_ADVANCE_MS, t0), AUTO_ADVANCE_MS / 1000);
});

test("倒數在真正換圖的那一刻才到 0", () => {
	const t0 = 1_000_000;
	const deadline = t0 + AUTO_ADVANCE_MS;
	assert.equal(secondsLeft(deadline, deadline - 1), 1);
	assert.equal(secondsLeft(deadline, deadline), 0);
});

test("過了期限不會變負數", () => {
	// 分頁丟到背景再切回來時 now 已經越過 deadline —— 負數會閃一下才歸零。
	assert.equal(secondsLeft(1000, 9999), 0);
});

test("沒有在自動輪播時回 null —— 呼叫端據此不畫", () => {
	assert.equal(secondsLeft(null, Date.now()), null);
});

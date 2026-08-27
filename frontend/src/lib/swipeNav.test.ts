import { test } from "node:test";
import assert from "node:assert/strict";
import {
	LOCK_PX,
	SWIPE_EDGE,
	SWIPE_RATIO,
	lockDecision,
	scrollerBlocks,
	startsInEdge,
} from "./swipeNav.ts";

const W = 390;

// —— 邊緣 ——————————————————————————————————————————————————

test("起手在螢幕邊緣就整個讓開 —— 那是 iOS 的返回手勢", () => {
	assert.equal(startsInEdge(SWIPE_EDGE - 1, W), true);
	assert.equal(startsInEdge(W - SWIPE_EDGE + 1, W), true);
	// 邊界:剛好等於門檻不算邊緣。
	assert.equal(startsInEdge(SWIPE_EDGE, W), false);
	assert.equal(startsInEdge(W - SWIPE_EDGE, W), false);
	assert.equal(startsInEdge(W / 2, W), false);
});

// —— 要不要接管 ————————————————————————————————————————————

const decide = (dx: number, dy = 0, scroller = null) =>
	lockDecision({ dx, dy, scroller });

test("還沒動夠就先等著", () => {
	assert.equal(decide(0, 0), "wait");
	assert.equal(decide(LOCK_PX - 1, LOCK_PX - 1), "wait");
});

test("水平贏得夠多就接管", () => {
	assert.equal(decide(-40, 0), "lock");
	assert.equal(decide(40, 10), "lock");
});

test("斜著滑一律讓給捲動", () => {
	// 水平 40、垂直 40 → 40 < 40 × 1.5,不接管。
	assert.equal(decide(40, 40), "abandon");
	assert.equal(decide(40, -40), "abandon");
});

test("角度的邊界:剛好打平算接管,再斜一點就讓開", () => {
	const dy = 60 / SWIPE_RATIO; // 60 === dy × 1.5 —— 判準是 `<`,平手歸接管
	assert.equal(decide(60, dy), "lock");
	assert.equal(decide(60, dy + 1), "abandon");
});

test("純垂直是捲動,不是猶豫", () => {
	// 這條容易寫錯成 "wait" —— 那會讓每一次向下捲都在等一個永遠不來的水平位移。
	assert.equal(decide(0, 40), "abandon");
});

test("手指底下還捲得動的東西會擋下接管", () => {
	// .table-scroll 裡的六欄表格:390px 上量到 846/316。
	const table = { scrollLeft: 0, scrollWidth: 846, clientWidth: 316 };
	assert.equal(lockDecision({ dx: -60, dy: 0, scroller: table }), "abandon");
	// 已經捲到最右緣就放行 —— 那時使用者的意圖已經不在表格上。
	const atEnd = { scrollLeft: 846 - 316, scrollWidth: 846, clientWidth: 316 };
	assert.equal(lockDecision({ dx: -60, dy: 0, scroller: atEnd }), "lock");
});

// —— 可捲容器本身 ————————————————————————————————————————————

const table = (scrollLeft: number) => ({
	scrollLeft,
	scrollWidth: 846,
	clientWidth: 316,
});

test("表格還能往右捲時,往左滑是捲它,不是換筆記", () => {
	assert.equal(scrollerBlocks(table(0), "left"), true);
	assert.equal(scrollerBlocks(table(100), "left"), true);
});

test("已經捲到最右緣了,往左滑就放行給換筆記", () => {
	assert.equal(scrollerBlocks(table(846 - 316), "left"), false);
});

test("往右滑看的是另一側", () => {
	assert.equal(scrollerBlocks(table(0), "right"), false); // 已在最左
	assert.equal(scrollerBlocks(table(100), "right"), true);
});

test("根本不會左右捲的容器一律不攔", () => {
	const plain = { scrollLeft: 0, scrollWidth: 350, clientWidth: 350 };
	assert.equal(scrollerBlocks(plain, "left"), false);
	assert.equal(scrollerBlocks(plain, "right"), false);
});

test("1px 以內的子像素溢出不算可捲", () => {
	// 少了這條容差,幾乎每個區塊都會被當成可捲容器,整個功能靜靜失效。
	const hair = { scrollLeft: 0, scrollWidth: 350.5, clientWidth: 350 };
	assert.equal(scrollerBlocks(hair, "left"), false);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import {
	SWIPE_EDGE,
	SWIPE_MAX_MS,
	SWIPE_MIN_X,
	SWIPE_RATIO,
	scrollerBlocks,
	swipeDirection,
	type SwipePoint,
} from "./swipeNav.ts";

const W = 390;
const MID = W / 2;

/** 從畫面中央出發、耗時 200ms 的一次手勢。 */
function gesture(dx: number, dy = 0, ms = 200, x0 = MID): [SwipePoint, SwipePoint] {
	return [
		{ x: x0, y: 400, t: 1000 },
		{ x: x0 + dx, y: 400 + dy, t: 1000 + ms },
	];
}

const dir = (...args: Parameters<typeof gesture>) =>
	swipeDirection(...gesture(...args), W);

test("往左滑得夠遠 → left", () => {
	assert.equal(dir(-120), "left");
});

test("往右滑得夠遠 → right", () => {
	assert.equal(dir(120), "right");
});

test("位移不到下限就不算", () => {
	assert.equal(dir(-(SWIPE_MIN_X - 1)), null);
	// 剛好等於下限要算 —— 門檻寫成 `<` 還是 `<=` 在畫面上分不出來,只有這裡看得到。
	assert.equal(dir(-SWIPE_MIN_X), "left");
});

test("斜著滑一律讓給捲動", () => {
	// 水平 120,垂直 100 → 120 < 100 * 1.5,不算。
	assert.equal(dir(120, 100), null);
	assert.equal(dir(120, -100), null);
	// 同樣的水平位移,垂直小一點就算。
	assert.equal(dir(120, 40), "right");
});

test("垂直為 0 時不會被比例判準誤殺", () => {
	assert.equal(dir(-SWIPE_MIN_X, 0), "left");
});

test("比例的邊界:剛好打平算滑動,再斜一點就讓給捲動", () => {
	const dy = 120 / SWIPE_RATIO; // 120 === dy * 1.5 —— 判準是 `<`,平手歸滑動
	assert.equal(dir(120, dy), "right");
	assert.equal(dir(120, dy + 1), null);
});

test("起點在左邊緣 → 讓給瀏覽器的返回手勢", () => {
	assert.equal(dir(150, 0, 200, SWIPE_EDGE - 1), null);
	assert.equal(dir(150, 0, 200, SWIPE_EDGE), "right");
});

test("起點在右邊緣 → 同樣讓開", () => {
	assert.equal(dir(-150, 0, 200, W - SWIPE_EDGE + 1), null);
	assert.equal(dir(-150, 0, 200, W - SWIPE_EDGE), "left");
});

test("拖太久就不是滑,是在選字", () => {
	assert.equal(dir(-150, 0, SWIPE_MAX_MS + 1), null);
	assert.equal(dir(-150, 0, SWIPE_MAX_MS), "left");
});

test("完全沒動 → null(不是 right)", () => {
	assert.equal(dir(0), null);
});

// —— scrollerBlocks:手指底下那個左右可捲的東西攔不攔得住 ——————————————

const table = (scrollLeft: number) => ({
	scrollLeft,
	scrollWidth: 576, // .table-scroll 裡的表格 min-width: 36rem
	clientWidth: 350, // 390px 手機扣掉內距
});

test("表格還能往右捲時,往左滑是捲它,不是換筆記", () => {
	assert.equal(scrollerBlocks(table(0), "left"), true);
	assert.equal(scrollerBlocks(table(100), "left"), true);
});

test("已經捲到最右緣了,往左滑就放行給換筆記", () => {
	assert.equal(scrollerBlocks(table(576 - 350), "left"), false);
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

import { test } from "node:test";
import assert from "node:assert/strict";
import {
	FLICK_MIN_PX,
	commitThreshold,
	dampedOffset,
	flyOutOffset,
	shouldCommit,
} from "./swipeDrag.ts";

const W = 390; // iPhone 直式
const T = commitThreshold(W); // 390 × 0.22 ≈ 85.8

test("臨界距離跟著寬度走,但夾在 56–96", () => {
	assert.ok(Math.abs(commitThreshold(390) - 85.8) < 0.1);
	// 很窄的螢幕:按比例會小到手一抖就換。
	assert.equal(commitThreshold(200), 56);
	// 很寬的螢幕:按比例會遠到要橫跨半個畫面。
	assert.equal(commitThreshold(1440), 96);
});

// —— 橡皮筋 ————————————————————————————————————————————————

test("臨界點之前 1:1 跟著手指", () => {
	// 直接操作要對得上手指,差一點都會覺得黏。
	assert.equal(dampedOffset(0, W), 0);
	assert.equal(dampedOffset(40, W), 40);
	assert.equal(dampedOffset(-40, W), -40);
	assert.ok(Math.abs(dampedOffset(T, W) - T) < 0.001);
});

test("超過臨界點之後變重,而且有上限", () => {
	const a = dampedOffset(T + 50, W);
	const b = dampedOffset(T + 500, W);
	// 還是往同一個方向、還在變大 —— 只是愈來愈慢。
	assert.ok(a > T && b > a, `${T} < ${a} < ${b}`);
	// 拖到天邊也不會超過 threshold + limit(limit = 0.9T)。
	assert.ok(dampedOffset(T + 100000, W) < T * 1.9 + 0.001);
	// 「變重」本身就是回饋:同樣再拖 50px,超過之後走的距離明顯比較短。
	assert.ok(a - T < 50, `超過臨界點後 50px 的手指位移只該走 ${a - T}px`);
});

test("橡皮筋兩邊對稱", () => {
	assert.ok(Math.abs(dampedOffset(-(T + 80), W) + dampedOffset(T + 80, W)) < 1e-9);
});

// —— 放手要不要換 ————————————————————————————————————————————

test("拖過臨界點就換,不管拖了多久", () => {
	// ⚠️ 這條是這次改動的重點:舊的 SWIPE_MAX_MS(700ms)會讓一個慢慢拖過臨界點
	// 的正確手勢無聲彈回去。直接操作之下那是正常操作。
	assert.equal(shouldCommit({ dx: -T, dtMs: 200, width: W }), true);
	assert.equal(shouldCommit({ dx: -T, dtMs: 5000, width: W }), true);
});

test("沒到臨界點就彈回去", () => {
	assert.equal(shouldCommit({ dx: -(T - 1), dtMs: 300, width: W }), false);
});

test("甩一下也算 —— 只看距離的話快速輕甩會覺得沒反應", () => {
	// 40px / 50ms = 0.8 px/ms,超過 0.5。
	assert.equal(shouldCommit({ dx: -40, dtMs: 50, width: W }), true);
	// 同樣距離但慢慢移動 → 不算。
	assert.equal(shouldCommit({ dx: -40, dtMs: 400, width: W }), false);
});

test("再快也要真的動過", () => {
	// 點一下的手抖:位移不到下限,速度再高都不算。
	assert.equal(
		shouldCommit({ dx: -(FLICK_MIN_PX - 1), dtMs: 1, width: W }),
		false,
	);
});

test("dtMs 為 0 不會讓每次點擊都變成「甩」", () => {
	// 合成事件可能落在同一毫秒;除以 0 會得到 Infinity。
	assert.equal(shouldCommit({ dx: -30, dtMs: 0, width: W }), false);
	// 但距離夠的話仍然算 —— 那條路徑不依賴速度。
	assert.equal(shouldCommit({ dx: -200, dtMs: 0, width: W }), true);
});

// —— 飛出去 ————————————————————————————————————————————————

test("飛出去要完全離開視野,而且方向跟著手指", () => {
	assert.ok(flyOutOffset(-10, W) < -W, "停在邊緣會留下看得見的殘影");
	assert.ok(flyOutOffset(10, W) > W);
});

import test from "node:test";
import assert from "node:assert/strict";
import {
	INITIAL_TAP_STATE,
	TAPS_REQUIRED,
	TAP_WINDOW_MS,
	hintFor,
	tap,
} from "./secretUnlock.ts";

/** 連點 n 下(每下間隔 gap),回傳每一下的結果。 */
function burst(n: number, gap = 200) {
	let s = INITIAL_TAP_STATE;
	let t = 1_000_000;
	const out = [];
	for (let i = 0; i < n; i++) {
		t += gap;
		const r = tap(s, t);
		s = r.state;
		out.push(r);
	}
	return out;
}

test("剛好第 7 下才觸發", () => {
	const r = burst(TAPS_REQUIRED);
	assert.equal(r.filter((x) => x.fired).length, 1);
	assert.equal(r[TAPS_REQUIRED - 1].fired, true);
});

test("第 6 下不觸發 —— 少一下就是沒有", () => {
	assert.equal(burst(TAPS_REQUIRED - 1).some((x) => x.fired), false);
});

test("觸發後狀態歸零,第 8 下不會再觸發一次", () => {
	const r = burst(TAPS_REQUIRED + 1);
	assert.equal(r.filter((x) => x.fired).length, 1);
	assert.equal(r[TAPS_REQUIRED].fired, false);
});

test("超過窗口就從 1 重新算,而不是把這一下丟掉", () => {
	let s = INITIAL_TAP_STATE;
	let t = 1_000_000;
	for (let i = 0; i < 4; i++) {
		t += 200;
		s = tap(s, t).state;
	}
	assert.equal(s.count, 4);
	t += TAP_WINDOW_MS + 1; // 停頓太久
	const r = tap(s, t);
	assert.equal(r.state.count, 1, "這一下要算成新一輪的第一下");
	assert.equal(r.fired, false);
});

test("剛好卡在窗口邊界上算連續", () => {
	const s = tap(INITIAL_TAP_STATE, 1000).state;
	assert.equal(tap(s, 1000 + TAP_WINDOW_MS).state.count, 2);
	assert.equal(tap(s, 1000 + TAP_WINDOW_MS + 1).state.count, 1);
});

test("窗口寬到電子紙來得及 —— 每下隔 1.4 秒仍然湊得滿", () => {
	// 這條釘的是那個「刻意放寬」的決定。有人把窗口調回 400ms 時它會紅。
	assert.equal(burst(TAPS_REQUIRED, 1400).filter((x) => x.fired).length, 1);
});

test("提示第 3 下才出現,而且數字會往下走", () => {
	const r = burst(TAPS_REQUIRED - 1);
	assert.equal(hintFor(r[0].state), null);
	assert.equal(hintFor(r[1].state), null);
	assert.equal(hintFor(r[2].state), "還差 4 下");
	assert.equal(hintFor(r[5].state), "還差 1 下");
});

test("沒點過的時候沒有提示", () => {
	assert.equal(hintFor(INITIAL_TAP_STATE), null);
});

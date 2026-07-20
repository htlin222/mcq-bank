import { test } from "node:test";
import assert from "node:assert/strict";
import {
	pickNextKind,
	remainingNewToday,
	parseNewLimit,
	DEFAULT_NEW_PER_DAY,
	NEW_EVERY,
	type QueueState,
} from "./queue-mix.ts";

const S = (o: Partial<QueueState>): QueueState => ({
	served: 0,
	learning: 0,
	dueReview: 0,
	newAvailable: 0,
	newRemaining: 0,
	...o,
});

test("預設 20 張/天、每 4 格給新卡一格", () => {
	assert.equal(DEFAULT_NEW_PER_DAY, 20);
	assert.equal(NEW_EVERY, 4);
});

test("learning 永遠插隊", () => {
	assert.equal(
		pickNextKind(
			S({ served: 3, learning: 1, dueReview: 9, newAvailable: 9, newRemaining: 9 }),
		),
		"learning",
	);
});

test("第 4 個位置(served=3)輪到新卡,其餘給到期卡", () => {
	assert.equal(
		pickNextKind(S({ served: 0, dueReview: 5, newAvailable: 5, newRemaining: 5 })),
		"due",
	);
	assert.equal(
		pickNextKind(S({ served: 1, dueReview: 5, newAvailable: 5, newRemaining: 5 })),
		"due",
	);
	assert.equal(
		pickNextKind(S({ served: 3, dueReview: 5, newAvailable: 5, newRemaining: 5 })),
		"new",
	);
	assert.equal(
		pickNextKind(S({ served: 7, dueReview: 5, newAvailable: 5, newRemaining: 5 })),
		"new",
	);
});

test("新卡額度用完就全給到期卡", () => {
	assert.equal(
		pickNextKind(S({ served: 3, dueReview: 5, newAvailable: 5, newRemaining: 0 })),
		"due",
	);
});

test("沒有到期卡時新卡連發,額度歸零則 null", () => {
	assert.equal(pickNextKind(S({ newAvailable: 5, newRemaining: 2 })), "new");
	assert.equal(pickNextKind(S({ newAvailable: 5, newRemaining: 0 })), null);
	assert.equal(pickNextKind(S({ newAvailable: 0, newRemaining: 5 })), null);
});

test("全空回 null(佇列清空)", () => {
	assert.equal(pickNextKind(S({ served: 7, newRemaining: 20 })), null);
});

test("remainingNewToday 不為負", () => {
	assert.equal(remainingNewToday(5, 20), 15);
	assert.equal(remainingNewToday(25, 20), 0);
	assert.equal(remainingNewToday(0, 0), 0);
});

test("parseNewLimit:未帶用預設,'0' 代表今天只清舊帳,上限 200", () => {
	assert.equal(parseNewLimit(undefined), DEFAULT_NEW_PER_DAY);
	assert.equal(parseNewLimit(""), DEFAULT_NEW_PER_DAY);
	assert.equal(parseNewLimit("0"), 0);
	assert.equal(parseNewLimit("35"), 35);
	assert.equal(parseNewLimit("9999"), 200);
	assert.equal(parseNewLimit("-3"), DEFAULT_NEW_PER_DAY);
	assert.equal(parseNewLimit("abc"), DEFAULT_NEW_PER_DAY);
});

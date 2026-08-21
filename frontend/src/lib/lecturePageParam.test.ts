import assert from "node:assert/strict";
import { test } from "node:test";
import {
	nextPageSearch,
	pageParamFor,
	readPageParam,
} from "./lecturePageParam.ts";

function must(v: URLSearchParams | null): URLSearchParams {
	if (!v) throw new Error("預期會有新的 query string,卻回了 null");
	return v;
}

test("readPageParam:1-based 進來,0-indexed 出去", () => {
	assert.equal(readPageParam("1"), 0);
	assert.equal(readPageParam("30"), 29);
});

test("readPageParam:看不懂就回 null,不猜也不夾", () => {
	// 夾到第一頁的話,`?page=abc` 會靜靜地把人送到開頭,看起來像連結壞了一半。
	for (const raw of [null, "", "0", "-3", "abc", " ", "NaN"]) {
		assert.equal(readPageParam(raw), null, `${JSON.stringify(raw)} 應該回 null`);
	}
});

test("readPageParam 對尾巴的雜訊寬鬆 —— 這是刻意的", () => {
	// parseInt 會把 "12abc" 讀成 12、"1.5e3" 讀成 1。網址常常是手打或被聊天軟體
	// 截過的,能讀出開頭那個數字就用,比整條參數失效好。
	assert.equal(readPageParam("12abc"), 11);
	assert.equal(readPageParam("1.5e3"), 0);
});

test("pageParamFor:第一頁不寫參數", () => {
	assert.equal(pageParamFor(0), null);
	assert.equal(pageParamFor(1), "2");
	assert.equal(pageParamFor(29), "30");
});

test("讀寫互為反函式", () => {
	for (const idx of [0, 1, 7, 29, 500]) {
		const raw = pageParamFor(idx);
		assert.equal(readPageParam(raw), idx === 0 ? null : idx, `第 ${idx} 頁對不上`);
	}
});

test("nextPageSearch:沒變就回 null —— 少了這道閘就是無窮迴圈", () => {
	assert.equal(nextPageSearch(new URLSearchParams("page=30"), 29), null);
	assert.equal(nextPageSearch(new URLSearchParams(""), 0), null);
	assert.equal(nextPageSearch(new URLSearchParams("q=abc"), 0), null);
});

test("nextPageSearch:換頁時寫入新值", () => {
	const out = must(nextPageSearch(new URLSearchParams("page=30"), 44));
	assert.equal(out.get("page"), "45");
});

test("nextPageSearch:回到第一頁時把參數拿掉", () => {
	const out = must(nextPageSearch(new URLSearchParams("page=30"), 0));
	assert.equal(out.get("page"), null);
	assert.equal(out.toString(), "");
});

test("nextPageSearch:其他參數原樣保留", () => {
	const out = must(nextPageSearch(new URLSearchParams("q=CML&page=2"), 9));
	assert.equal(out.get("q"), "CML");
	assert.equal(out.get("page"), "10");
});

test("nextPageSearch 不改動傳進來的那一份", () => {
	const before = new URLSearchParams("page=2");
	nextPageSearch(before, 9);
	assert.equal(before.get("page"), "2", "原物件被就地改掉了");
});

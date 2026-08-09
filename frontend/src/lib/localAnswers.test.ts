// 本地作答鏡像。跟 attemptOutbox 的分工見 localAnswers.ts 開頭:
// outbox 回答「有什麼要補送」,這支回答「畫面該顯示什麼」。

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

class MemStorage {
	map = new Map<string, string>();
	throwOnWrite = false;
	getItem(k: string) { return this.map.has(k) ? this.map.get(k)! : null; }
	setItem(k: string, v: string) {
		if (this.throwOnWrite) throw new Error("QuotaExceededError");
		this.map.set(k, v);
	}
	removeItem(k: string) { this.map.delete(k); }
}
const store = new MemStorage();
(globalThis as unknown as { localStorage: MemStorage }).localStorage = store;

const { recordAnswer, forgetAnswer, getAnswer, count, clearAll } = await import("./localAnswers.ts");

beforeEach(() => { store.map.clear(); store.throwOnWrite = false; clearAll(); });

test("記下來之後讀得到,對錯轉成 0/1", () => {
	recordAnswer("113-050", "B", true);
	assert.deepEqual(
		{ ...getAnswer("113-050"), at: 0 },
		{ chosen: "B", correct: 1, at: 0 },
	);
	recordAnswer("113-051", "D", false);
	assert.equal(getAnswer("113-051")?.correct, 0);
});

test("同一題再答一次會覆蓋 —— 最後一次才是現況", () => {
	recordAnswer("113-050", "A", false);
	recordAnswer("113-050", "B", true);
	assert.equal(getAnswer("113-050")?.chosen, "B");
	assert.equal(count(), 1);
});

test("清除作答紀錄要一起忘掉,否則下次讀回來又被本地救回去", () => {
	recordAnswer("113-050", "B", true);
	forgetAnswer("113-050");
	assert.equal(getAnswer("113-050"), undefined);
});

test("忘掉不存在的題目不會炸,也不會多寫一筆", () => {
	assert.doesNotThrow(() => forgetAnswer("113-999"));
	assert.equal(count(), 0);
});

test("localStorage 壞掉時不丟例外 —— 這支活在作答路徑上", () => {
	store.throwOnWrite = true;
	assert.doesNotThrow(() => recordAnswer("113-050", "B", true));
});

test("壞掉的 JSON 或陣列(舊格式)當成空,不丟例外", () => {
	store.map.set("mcq:local-answers:v1", "{ not json");
	assert.equal(getAnswer("113-050"), undefined);
	store.map.set("mcq:local-answers:v1", "[1,2,3]");
	assert.equal(getAnswer("113-050"), undefined);
	assert.doesNotThrow(() => recordAnswer("113-050", "B", true));
});

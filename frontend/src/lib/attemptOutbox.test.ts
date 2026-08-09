// 作答離線佇列。存在的理由見 attemptOutbox.ts 開頭 —— 2026-08-09 連續四題
// (113-097～100)完全沒進 D1,而且失敗是靜默的。

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

// node --test 沒有 localStorage。用最小替身,並保留「會丟例外」的能力 ——
// Safari 私密瀏覽下存取 localStorage 是直接 throw 的,那條路徑必須測到。
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

const { enqueue, remove, list, size, clear, flush } = await import("./attemptOutbox.ts");

function mk(idem: string, qid = "113-097") {
	return { idem, question_id: qid, chosen: "B", confidence: 3, elapsed_ms: 1200, queued_at: 1 };
}

beforeEach(() => { store.map.clear(); store.throwOnWrite = false; clear(); });

test("入列後讀得到,移除後就不在了", () => {
	enqueue(mk("a"));
	assert.equal(size(), 1);
	assert.equal(list()[0].question_id, "113-097");
	remove("a");
	assert.equal(size(), 0);
});

test("同一個 idem 重複入列只留一筆 —— 重試不會長出兩筆", () => {
	enqueue(mk("a"));
	enqueue(mk("a"));
	assert.equal(size(), 1);
});

test("同一題答兩次是兩筆(idem 不同),而且後送的排在後面", () => {
	enqueue({ ...mk("first"), chosen: "A" });
	enqueue({ ...mk("second"), chosen: "D" });
	assert.deepEqual(list().map((x) => x.chosen), ["A", "D"]);
});

test("flush 成功會逐筆清掉", async () => {
	enqueue(mk("a")); enqueue(mk("b"));
	const seen: string[] = [];
	const r = await flush(async (a) => { seen.push(a.idem); });
	assert.deepEqual(r, { sent: 2, failed: 0 });
	assert.equal(size(), 0);
	assert.deepEqual(seen, ["a", "b"]);
});

test("遇到第一個失敗就停,沒送出的留在佇列 —— 網路還沒通,硬送只是白費電池", async () => {
	enqueue(mk("a")); enqueue(mk("b")); enqueue(mk("c"));
	let n = 0;
	const r = await flush(async () => {
		n++;
		if (n === 2) throw new Error("offline");
	});
	assert.deepEqual(r, { sent: 1, failed: 2 });
	assert.deepEqual(list().map((x) => x.idem), ["b", "c"], "失敗那筆與其後都要留著");
	assert.equal(n, 2, "第二筆失敗後不該再送第三筆");
});

test("localStorage 壞掉時不丟例外 —— 這支活在作答路徑上", () => {
	store.throwOnWrite = true;
	assert.doesNotThrow(() => enqueue(mk("a")));
	store.throwOnWrite = false;
});

test("讀到壞掉的 JSON 當成空佇列,不丟例外", () => {
	store.map.set("mcq:attempt-outbox:v1", "{ not json");
	assert.deepEqual(list(), []);
	assert.doesNotThrow(() => enqueue(mk("a")));
});

test("過濾掉形狀不對的項目 —— 舊版格式或被別的東西寫壞", () => {
	store.map.set("mcq:attempt-outbox:v1", JSON.stringify([{ nope: 1 }, mk("ok")]));
	assert.deepEqual(list().map((x) => x.idem), ["ok"]);
});

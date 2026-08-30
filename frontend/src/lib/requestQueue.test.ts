import { test } from "node:test";
import assert from "node:assert/strict";
import { createGate } from "./requestQueue.ts";

/** 手動控制的 promise —— 用時間 sleep 來測並行度會在慢機器上飄。 */
function deferred<T = void>() {
	let resolve!: (v: T) => void;
	let reject!: (e: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

test("同時在飛的不超過上限,其餘排隊", async () => {
	const gate = createGate(2);
	const d = [deferred(), deferred(), deferred(), deferred()];
	let started = 0;
	const runs = d.map((x) =>
		gate(() => {
			started++;
			return x.promise;
		}),
	);
	await Promise.resolve();
	assert.equal(started, 2, "一開始只能有 2 個在飛");

	d[0].resolve();
	await runs[0];
	await Promise.resolve();
	assert.equal(started, 3, "空出一個位子才放下一個進來");

	d[1].resolve();
	d[2].resolve();
	d[3].resolve();
	await Promise.all(runs);
	assert.equal(started, 4);
});

test("失敗照原樣傳出去,而且位子要放掉", async () => {
	const gate = createGate(1);
	await assert.rejects(
		gate(() => Promise.reject(new Error("boom"))),
		/boom/,
	);
	// 前一個失敗之後閘門還開得了 —— 少了 finally 這裡會永遠 pending。
	assert.equal(await gate(() => Promise.resolve(7)), 7);
});

test("job 同步丟例外也不會鎖死閘門", async () => {
	const gate = createGate(1);
	await assert.rejects(
		gate(() => {
			throw new Error("sync");
		}),
		/sync/,
	);
	assert.equal(await gate(() => Promise.resolve("ok")), "ok");
});

test("上限至少是 1 —— 0 或負數會讓所有 job 永遠排隊", async () => {
	const gate = createGate(0);
	assert.equal(await gate(() => Promise.resolve(1)), 1);
});

test("回傳值原樣傳出去", async () => {
	const gate = createGate(3);
	const out = await Promise.all([1, 2, 3, 4].map((n) => gate(() => Promise.resolve(n * 2))));
	assert.deepEqual(out, [2, 4, 6, 8]);
});

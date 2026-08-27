import { test } from "node:test";
import assert from "node:assert/strict";
import {
	PREFETCH_TTL_MS,
	prefetchStampKey,
	runWithConcurrency,
	shouldPrefetchYear,
} from "./yearPrefetch.ts";

// —— 該不該拓 ————————————————————————————————————————————————

const NOW = 1_700_000_000_000;

test("沒拓過就拓", () => {
	assert.equal(
		shouldPrefetchYear({ lastRunAt: null, now: NOW, saveData: false }),
		true,
	);
});

test("使用者要省流量時一律不拓", () => {
	// 即使從沒拓過也不拓 —— 文字只有幾百 KB,但那是我們的判斷,不是他的。
	assert.equal(
		shouldPrefetchYear({ lastRunAt: null, now: NOW, saveData: true }),
		false,
	);
});

test("24 小時內拓過就不重拓", () => {
	assert.equal(
		shouldPrefetchYear({ lastRunAt: NOW - 1000, now: NOW, saveData: false }),
		false,
	);
	// 邊界:剛好滿 24 小時要拓。
	assert.equal(
		shouldPrefetchYear({
			lastRunAt: NOW - PREFETCH_TTL_MS,
			now: NOW,
			saveData: false,
		}),
		true,
	);
	assert.equal(
		shouldPrefetchYear({
			lastRunAt: NOW - PREFETCH_TTL_MS + 1,
			now: NOW,
			saveData: false,
		}),
		false,
	);
});

test("時間戳在未來時要拓,不是永遠不拓", () => {
	// 手動改過系統時間、或跨時區搬機器都會出現。把它當成「剛拓過」會讓這個功能
	// 在那台裝置上**永久**失效,而且完全無聲。
	assert.equal(
		shouldPrefetchYear({ lastRunAt: NOW + 999_999, now: NOW, saveData: false }),
		true,
	);
});

test("鍵帶年份,不同年份互不影響", () => {
	assert.notEqual(prefetchStampKey(113), prefetchStampKey(114));
	assert.match(prefetchStampKey(114), /114$/);
});

// —— 並行執行 ————————————————————————————————————————————————

/** 記錄「同時在飛的最大數量」。 */
function tracker() {
	let inFlight = 0;
	let peak = 0;
	return {
		get peak() {
			return peak;
		},
		async run() {
			inFlight++;
			peak = Math.max(peak, inFlight);
			await new Promise((r) => setTimeout(r, 1));
			inFlight--;
		},
	};
}

test("全部跑完,而且同時在飛的不超過上限", async () => {
	const t = tracker();
	const items = Array.from({ length: 20 }, (_, i) => i);
	const seen: number[] = [];
	const out = await runWithConcurrency(
		items,
		async (i) => {
			await t.run();
			seen.push(i);
		},
		{ concurrency: 4 },
	);
	assert.equal(out.done, 20);
	assert.equal(out.failed, 0);
	assert.equal(out.aborted, false);
	assert.deepEqual([...seen].sort((a, b) => a - b), items);
	assert.ok(t.peak <= 4, `同時在飛最多 4 個,實際 ${t.peak}`);
	// 對照組:真的有並行,不是一個一個跑 —— 少了這條,把 concurrency 寫死成 1
	// 也會通過上面每一條。
	assert.ok(t.peak > 1, `該是並行的,實際峰值 ${t.peak}`);
});

test("一題失敗不會讓剩下的都拓不到", async () => {
	const out = await runWithConcurrency(
		[1, 2, 3, 4, 5],
		async (i) => {
			if (i === 2) throw new Error("boom");
		},
		{ concurrency: 2 },
	);
	assert.equal(out.done, 5, "五題都該跑過");
	assert.equal(out.failed, 1);
});

test("abort 之後就停下來,不會把剩下的跑完", async () => {
	const signal = { aborted: false };
	let started = 0;
	const out = await runWithConcurrency(
		Array.from({ length: 50 }, (_, i) => i),
		async () => {
			started++;
			if (started === 4) signal.aborted = true;
			await new Promise((r) => setTimeout(r, 1));
		},
		{ concurrency: 2, signal },
	);
	assert.equal(out.aborted, true);
	assert.ok(started < 50, `該提早停下,實際跑了 ${started} 個`);
});

test("回報進度,而且最後一次就是總數", async () => {
	const calls: [number, number][] = [];
	await runWithConcurrency(
		[1, 2, 3],
		async () => {},
		{ concurrency: 1, onProgress: (d, t) => calls.push([d, t]) },
	);
	assert.deepEqual(calls, [
		[1, 3],
		[2, 3],
		[3, 3],
	]);
});

test("空清單不丟例外,也不會卡住", async () => {
	const out = await runWithConcurrency([], async () => {}, { concurrency: 4 });
	assert.deepEqual(out, { done: 0, failed: 0, aborted: false });
});

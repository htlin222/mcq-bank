// 進年份頁時,在背景把那一年的題目 payload 抓進 Service Worker 快取。
// 設計:docs/plans/2026-08-27-offline-year-prefetch-design.md
//
// 這個檔案**不 import 任何東西** —— 純函式才進得了 `pnpm test`(node --test),
// 而接線那半在 hooks/useYearPrefetch.ts。同 lib/autoHideChrome.ts 的分法。
//
// ⚠️ **刻意不沿用 `questionStore.prefetch()`**,雖然它看起來剛好就是要的東西:
//   - 它的 TTL 是 60 秒。那是「換題預抓」的正確 horizon,不是「拓一整年」的 ——
//     兩分鐘後再進同一個年份頁,100 趟會整批重來。
//   - 它的記憶體 LRU 只有 40 筆。拓 100 題會把它洗過兩遍半,把使用者剛才在讀的
//     那幾題擠掉。
//   - 它沒有並行度上限。

/** 同時在飛的請求數。不設上限的話 100 個請求會把使用者真正想開的那一題排到後面。 */
export const PREFETCH_CONCURRENCY = 4;

/** 同一年多久內不重拓。60 秒(questionStore 的 TTL)在這裡是錯的 horizon。 */
export const PREFETCH_TTL_MS = 24 * 60 * 60 * 1000;

/** localStorage 的鍵。只存「上次拓完的時間」,不存拓了哪些題 —— 見 countCached。 */
export function prefetchStampKey(year: number | string): string {
	return `mcq:year-prefetch:v1:${year}`;
}

/**
 * 現在該不該拓這一年。
 *
 * `saveData` 是使用者在系統設定裡明講「我要省流量」—— 那就別自作主張。文字只有
 * 160–410 KB,但那是我們的判斷,不是他的。
 */
export function shouldPrefetchYear(o: {
	lastRunAt: number | null;
	now: number;
	saveData: boolean;
}): boolean {
	if (o.saveData) return false;
	if (o.lastRunAt === null) return true;
	// 時間戳來自 localStorage,可能被手動改過或跨時區搬過機器。未來的時間視為
	// 「剛拓過」會讓功能永久失效,所以只認「過了夠久」這一個方向。
	const age = o.now - o.lastRunAt;
	return age < 0 || age >= PREFETCH_TTL_MS;
}

export type PrefetchOutcome = {
	done: number;
	failed: number;
	aborted: boolean;
};

/**
 * 把一批工作跑完,同時在飛的不超過 `concurrency` 個。
 *
 * **失敗不中斷整批**:預抓失敗就只是那一題沒拓到,真的要看的時候 `get()` 會再
 * 試一次。一題失敗就整批放棄的話,一個 500 會讓剩下 99 題全都拓不到。
 */
export async function runWithConcurrency<T>(
	items: readonly T[],
	work: (item: T) => Promise<unknown>,
	opts: {
		concurrency?: number;
		signal?: { aborted: boolean } | null;
		onProgress?: (done: number, total: number) => void;
	} = {},
): Promise<PrefetchOutcome> {
	const limit = Math.max(1, opts.concurrency ?? PREFETCH_CONCURRENCY);
	const total = items.length;
	let next = 0;
	let done = 0;
	let failed = 0;

	async function worker(): Promise<void> {
		for (;;) {
			// 每一輪都重新看 signal —— 使用者只是路過年份頁的話,拓到一半就該停。
			if (opts.signal?.aborted) return;
			const i = next++;
			if (i >= total) return;
			try {
				await work(items[i]);
			} catch {
				failed++;
			}
			done++;
			opts.onProgress?.(done, total);
		}
	}

	await Promise.all(
		Array.from({ length: Math.min(limit, total) }, () => worker()),
	);
	return { done, failed, aborted: !!opts.signal?.aborted };
}

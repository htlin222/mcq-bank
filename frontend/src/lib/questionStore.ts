// 換題時那幾百毫秒的空窗,是「等網路」而不是「等畫面」。
//
// 這個 store 存在的理由只有一個:讓 `peek()` 在 **render 當下同步** 就能回答
// 「這題的資料有沒有在手上」。有的話 useQuestion 第一次 render 就直接畫出完整
// 題目,連 loading 狀態都不進;沒有的話才走網路。上一題/下一題的 id 在按鈕出
// 現時就已知,所以 Question.tsx 會先 prefetch 進來 —— 命中率高到「下一題」幾
// 乎恆為 0ms。
//
// 為什麼不交給 Service Worker 就好:`/api/questions/:id` 在 sw.ts 是
// NetworkFirst,拿快取之前一定先等網路(離線才回快取)。改成 StaleWhileRevalidate
// 會讓「存完詳解 → reload 看到自己的修改」讀到舊值,那是比慢更糟的錯。所以快取
// 做在應用層 —— 這裡失效時機我們自己掌握(存檔後 set() 覆寫)。
//
// 刻意不引入 TanStack Query:整個 app 只有這一條熱路徑需要,一個 100 行、可測
// 的 store 比多一個 runtime 依賴划算。

export type QuestionStore<T> = {
	/** 同步讀,不觸發抓取。沒有就 undefined。 */
	peek(id: string | undefined): T | undefined;
	/** 有快取且未過 ttl。過期資料仍然 peek 得到(SWR),只是該背景重抓。 */
	isFresh(id: string | undefined): boolean;
	/** 有快取就直接回,否則抓;同一 id 併發只打一次網路。 */
	get(id: string, opts?: { force?: boolean }): Promise<T>;
	/** 射後不理。失敗只是沒命中,不會冒出未捕捉的 rejection。 */
	prefetch(id: string | undefined): void;
	/** 測試/等待用:目前該 id 的 in-flight promise(沒有就 undefined)。 */
	inflight(id: string): Promise<unknown> | undefined;
	set(id: string, value: T): void;
	invalidate(id: string | undefined): void;
	clear(): void;
	size(): number;
};

type Entry<T> = { value: T; at: number };

export function createQuestionStore<T>(
	fetcher: (id: string) => Promise<T>,
	opts: { max?: number; ttlMs?: number; now?: () => number } = {},
): QuestionStore<T> {
	const max = opts.max ?? 40;
	const ttlMs = opts.ttlMs ?? 60_000;
	const now = opts.now ?? (() => Date.now());

	// Map 的迭代順序就是插入順序,delete + set 即可把某筆搬到最新端 → LRU。
	const cache = new Map<string, Entry<T>>();
	const inFlight = new Map<string, Promise<T>>();

	function touch(id: string): Entry<T> | undefined {
		const e = cache.get(id);
		if (!e) return undefined;
		cache.delete(id);
		cache.set(id, e);
		return e;
	}

	function evict() {
		while (cache.size > max) {
			const oldest = cache.keys().next();
			if (oldest.done) break;
			cache.delete(oldest.value);
		}
	}

	function set(id: string, value: T) {
		cache.delete(id);
		cache.set(id, { value, at: now() });
		evict();
	}

	function get(id: string, o: { force?: boolean } = {}): Promise<T> {
		if (!o.force) {
			const hit = touch(id);
			if (hit && now() - hit.at < ttlMs) return Promise.resolve(hit.value);
		}
		const running = inFlight.get(id);
		if (running) return running;

		const p = fetcher(id)
			.then((value) => {
				set(id, value);
				return value;
			})
			.finally(() => {
				// 失敗不留痕:下一次呼叫要能重試,而不是永遠拿到同一個 rejected promise。
				if (inFlight.get(id) === p) inFlight.delete(id);
			});
		inFlight.set(id, p);
		return p;
	}

	return {
		peek(id) {
			if (!id) return undefined;
			return touch(id)?.value;
		},
		isFresh(id) {
			if (!id) return false;
			const e = cache.get(id);
			return !!e && now() - e.at < ttlMs;
		},
		get,
		prefetch(id) {
			if (!id) return;
			if (inFlight.has(id)) return;
			const e = cache.get(id);
			if (e && now() - e.at < ttlMs) return;
			void get(id).catch(() => {
				/* 預抓失敗就只是沒預抓到,真的需要時 get() 會再試一次 */
			});
		},
		inflight(id) {
			return inFlight.get(id)?.catch(() => undefined);
		},
		set,
		invalidate(id) {
			if (id) cache.delete(id);
		},
		clear() {
			cache.clear();
		},
		size() {
			return cache.size;
		},
	};
}

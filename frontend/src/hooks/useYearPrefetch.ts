import { useEffect, useRef, useState } from "react";
import { API_CACHE_NAME } from "../lib/sw-guards";
import {
	PREFETCH_CONCURRENCY,
	prefetchStampKey,
	runWithConcurrency,
	shouldPrefetchYear,
} from "../lib/yearPrefetch";

// 進年份頁時,在背景把那一年的題目 payload 抓進 Service Worker 快取。
// 設計:docs/plans/2026-08-27-offline-year-prefetch-design.md
//
// 判準全部在 lib/yearPrefetch.ts(純函式,有測試);這裡只有 DOM 才知道的事:
// idle 時機、localStorage、AbortController、以及「拓完了沒」要問誰。

export type YearOfflineState =
	| { kind: "idle" }
	| { kind: "running"; done: number; total: number }
	| { kind: "ready" };

/**
 * Service Worker 有沒有在接管這一頁。
 *
 * **沒有接管就一趟都不要發。** 收下這些回應的是 SW 的 runtime cache —— 它不在
 * (瀏覽器不支援、使用者關掉、或這是第一次造訪、SW 才剛裝好還沒 claim),那 100
 * 趟請求就是純粹的浪費:沒有人會把它們存起來,而使用者離線時一樣打不開。
 * 第一次造訪因此不拓,下一次導覽 SW 接管之後才會。
 */
function swControlling(): boolean {
	return (
		typeof navigator !== "undefined" &&
		"serviceWorker" in navigator &&
		!!navigator.serviceWorker.controller
	);
}

/** `navigator.connection` 不在 lib.dom 的型別裡(還是 draft)。 */
function saveDataOn(): boolean {
	const c = (navigator as { connection?: { saveData?: boolean } }).connection;
	return c?.saveData === true;
}

/**
 * 快取裡已經有幾題屬於這一年。
 *
 * **刻意去數快取,而不是自己記帳。** 記帳一定會跟真實快取漂移 —— 使用者清過站台
 * 資料、SW 換版、配額不足被瀏覽器丟掉,而帳還在。漂移的症狀是「顯示可離線,實際
 * 打不開」,那比不顯示更糟。
 */
async function countCached(ids: readonly string[]): Promise<number> {
	if (typeof caches === "undefined") return 0;
	try {
		const cache = await caches.open(API_CACHE_NAME);
		const keys = await cache.keys();
		const have = new Set(
			keys.map((r) => new URL(r.url).pathname).filter(Boolean),
		);
		return ids.filter((id) => have.has(`/api/questions/${id}`)).length;
	} catch {
		return 0;
	}
}

/** `requestIdleCallback` 在 WebKit 較舊的版本沒有 —— 退回一個短 timeout。 */
function onIdle(fn: () => void): () => void {
	const ric = (
		window as unknown as {
			requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number;
			cancelIdleCallback?: (h: number) => void;
		}
	).requestIdleCallback;
	if (ric) {
		const h = ric(fn, { timeout: 3000 });
		return () =>
			(
				window as unknown as { cancelIdleCallback?: (h: number) => void }
			).cancelIdleCallback?.(h);
	}
	const t = window.setTimeout(fn, 1200);
	return () => window.clearTimeout(t);
}

/**
 * @param year 目前這一頁的年份;`undefined` 時什麼都不做。
 * @param ids  這一年的題號,由清單提供 —— 這個 hook 不自己去查。
 */
export function useYearPrefetch(
	year: number | string | undefined,
	ids: readonly string[],
): YearOfflineState {
	const [state, setState] = useState<YearOfflineState>({ kind: "idle" });
	// ids 每次 render 都是新陣列,不能進 deps —— 用長度當觸發訊號,內容靠 ref 取。
	const idsRef = useRef(ids);
	idsRef.current = ids;

	useEffect(() => {
		if (!year || ids.length === 0) return;
		if (!swControlling()) return;
		const list = idsRef.current;
		const ac = new AbortController();
		let cancelled = false;

		const cancelIdle = onIdle(() => {
			void (async () => {
				// 先問快取:已經齊了就直接顯示可離線,一趟請求都不必發。這條同時
				// 涵蓋「昨天拓過、今天又進來」—— 時間戳過期不代表東西不在。
				const already = await countCached(list);
				if (cancelled) return;
				if (already >= list.length) {
					setState({ kind: "ready" });
					return;
				}

				let stamp: number | null = null;
				try {
					const raw = localStorage.getItem(prefetchStampKey(year));
					stamp = raw ? Number(raw) : null;
					if (stamp !== null && !Number.isFinite(stamp)) stamp = null;
				} catch {
					/* 無痕模式會丟例外 —— 當成沒拓過,頂多多拓一次 */
				}
				if (
					!shouldPrefetchYear({
						lastRunAt: stamp,
						now: Date.now(),
						saveData: saveDataOn(),
					})
				)
					return;

				setState({ kind: "running", done: already, total: list.length });

				const out = await runWithConcurrency(
					list,
					async (id) => {
						// 直接 fetch,不走 questionStore —— 它的 60 秒 TTL 與 40 筆記憶體
						// LRU 都是「換題預抓」的尺度,拿來拓一整年會把使用者正在讀的擠掉。
						// 這裡要的只是「讓 SW 看到這個請求並收進快取」。
						const res = await fetch(`/api/questions/${id}`, {
							signal: ac.signal,
							credentials: "same-origin",
						});
						// 讀完 body,否則 SW 那邊的 cachePut 可能還沒完成就被丟棄。
						await res.arrayBuffer();
					},
					{
						concurrency: PREFETCH_CONCURRENCY,
						signal: ac.signal,
						onProgress: (done) => {
							if (!cancelled)
								setState({
									kind: "running",
									done: already + done,
									total: list.length,
								});
						},
					},
				);
				if (cancelled || out.aborted) return;

				// 有失敗就**不要**寫時間戳:下次進來還會再試。寫下去的話,那幾題會
				// 缺整整 24 小時,而畫面上看不出來。
				if (out.failed === 0) {
					try {
						localStorage.setItem(prefetchStampKey(year), String(Date.now()));
					} catch {
						/* 無痕模式 */
					}
				}
				const have = await countCached(list);
				if (!cancelled)
					setState(
						have >= list.length ? { kind: "ready" } : { kind: "idle" },
					);
			})();
		});

		return () => {
			cancelled = true;
			cancelIdle();
			ac.abort();
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [year, ids.length]);

	return state;
}

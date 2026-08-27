import { useCallback, useEffect, useRef, useState } from "react";
import { API_CACHE_NAME, IMG_CACHE_NAME } from "../lib/sw-guards";
import {
	describeImageCost,
	hasRoomFor,
	imagesInQuestionPayload,
} from "../lib/offlineImages";
import { PREFETCH_CONCURRENCY, runWithConcurrency } from "../lib/yearPrefetch";

// 離線預載第二期:圖片。設計文件的最後一節。
//
// 跟文字那一期最重要的差別:**這一批不自動拓**。一年 8–17 MB,在行動網路上是真的
// 錢,而使用者沒有同意過。所以它是一顆按鈕,而且按鈕上先寫出張數與 MB。
//
// **圖片清單不必再打一輪 API** —— 文字那一期已經把整年的 payload 放進
// `api-json-v1` 了,共筆詳解就在裡面。直接讀快取,零請求。

export type YearImageState =
	| { kind: "unknown" }
	/** 這一年沒有圖(108 年真的是 0 張),不要顯示任何東西。 */
	| { kind: "none" }
	| { kind: "offer"; total: number; label: string }
	| { kind: "running"; done: number; total: number }
	| { kind: "ready"; total: number }
	| { kind: "no-room"; label: string };

async function readCachedPayloads(ids: readonly string[]): Promise<unknown[]> {
	if (typeof caches === "undefined") return [];
	const cache = await caches.open(API_CACHE_NAME);
	const out: unknown[] = [];
	for (const id of ids) {
		const res = await cache.match(`/api/questions/${id}`);
		if (!res) continue;
		try {
			out.push(await res.json());
		} catch {
			/* 壞掉的一筆不該讓整批停下來 */
		}
	}
	return out;
}

/** 這些圖有幾張已經在 img 快取裡。 */
async function countCachedImages(srcs: readonly string[]): Promise<number> {
	if (typeof caches === "undefined") return 0;
	try {
		const cache = await caches.open(IMG_CACHE_NAME);
		const keys = await cache.keys();
		const have = new Set(keys.map((r) => new URL(r.url).pathname));
		return srcs.filter((s) => have.has(s)).length;
	} catch {
		return 0;
	}
}

/**
 * @param ids   這一年的題號
 * @param ready 文字那一期拓完了沒。**沒拓完就不要算** —— 快取裡只有一半的
 *              payload,算出來的張數會偏低,而按鈕上那個數字是使用者用來決定
 *              要不要按的依據。
 */
export function useYearImages(ids: readonly string[], ready: boolean) {
	const [state, setState] = useState<YearImageState>({ kind: "unknown" });
	const srcsRef = useRef<string[]>([]);
	const idsRef = useRef(ids);
	idsRef.current = ids;

	useEffect(() => {
		if (!ready || ids.length === 0) {
			setState({ kind: "unknown" });
			return;
		}
		let cancelled = false;
		void (async () => {
			const payloads = await readCachedPayloads(idsRef.current);
			const srcs = [...new Set(payloads.flatMap(imagesInQuestionPayload))];
			srcsRef.current = srcs;
			if (cancelled) return;
			if (srcs.length === 0) {
				// 108 年真的一張圖都沒有,114 年只有 17 張。整塊不顯示比顯示
				// 「0 張」好 —— 後者只是多一行沒有意義的字。
				setState({ kind: "none" });
				return;
			}
			const have = await countCachedImages(srcs);
			if (cancelled) return;
			if (have >= srcs.length) {
				setState({ kind: "ready", total: srcs.length });
				return;
			}
			const quota = await navigator.storage?.estimate?.().catch(() => null);
			if (cancelled) return;
			const label = describeImageCost(srcs.length - have);
			setState(
				hasRoomFor(srcs.length - have, quota ?? null)
					? { kind: "offer", total: srcs.length, label }
					: { kind: "no-room", label },
			);
		})();
		return () => {
			cancelled = true;
		};
	}, [ready, ids.length]);

	const start = useCallback(async () => {
		const srcs = srcsRef.current;
		if (srcs.length === 0) return;
		setState({ kind: "running", done: 0, total: srcs.length });
		await runWithConcurrency(
			srcs,
			async (src) => {
				// CacheFirst 那條路由會自己收下。已經在快取裡的不會真的走網路。
				const res = await fetch(src, { credentials: "same-origin" });
				await res.arrayBuffer();
			},
			{
				concurrency: PREFETCH_CONCURRENCY,
				onProgress: (done, total) => setState({ kind: "running", done, total }),
			},
		);
		const have = await countCachedImages(srcs);
		setState(
			have >= srcs.length
				? { kind: "ready", total: srcs.length }
				: {
						kind: "offer",
						total: srcs.length,
						label: describeImageCost(srcs.length - have),
					},
		);
	}, []);

	return { state, start };
}

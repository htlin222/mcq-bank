import { useCallback, useEffect, useRef, useState } from "react";
import { commentCache, type Comment } from "../lib/commentApi";

/**
 * 討論串的讀取端 —— 跟 `useQuestion` 同一個形狀,理由也一樣:
 *
 * 1. **命中快取就別進 loading。** `peek()` 是同步的,所以 useState 的初始值就能
 *    是完整資料。切回「討論串」分頁時第一次 render 就畫得出來,連骨架都不閃。
 * 2. **沒命中才給骨架,而且資料要連同「屬於哪一題」一起存。** 只存留言陣列的話,
 *    換題後的第一個 render 會拿著上一題的討論串 —— 看起來像沒換到題。
 */
export function useComments(questionId: string | undefined) {
	const [entry, setEntry] = useState<{ id: string; items: Comment[] } | null>(
		() => {
			const hit = questionId ? commentCache.peek(questionId) : undefined;
			return hit && questionId ? { id: questionId, items: hit } : null;
		},
	);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<Error | null>(null);

	// 快速連按時先發的請求可能後回來,用它擋掉「已經不是當前題目」的寫入。
	const currentId = useRef(questionId);
	currentId.current = questionId;

	const load = useCallback(
		async (force: boolean) => {
			if (!questionId) return;
			const cached = commentCache.peek(questionId);
			if (cached) setEntry({ id: questionId, items: cached });
			if (!force && commentCache.isFresh(questionId)) return;

			// 手上有(即使過期的)資料就別開 loading —— 背景重抓不該讓畫面變回載入中。
			if (!cached) setLoading(true);
			try {
				const items = await commentCache.get(questionId, { force });
				if (currentId.current !== questionId) return;
				setEntry({ id: questionId, items });
				setError(null);
			} catch (e) {
				if (currentId.current !== questionId) return;
				setError(e as Error);
			} finally {
				if (currentId.current === questionId) setLoading(false);
			}
		},
		[questionId],
	);

	const reload = useCallback(() => load(true), [load]);

	useEffect(() => {
		setError(null);
		void load(false);
	}, [load]);

	// 同 useQuestion:state 在 id 剛變動的那個 render 還停在舊題,所以真正的答案
	// 要**在 render 當下**再問一次快取。
	const comments =
		(entry && entry.id === questionId ? entry.items : null) ??
		(questionId ? (commentCache.peek(questionId) ?? null) : null);

	return { comments, loading: loading && !comments, error, reload };
}

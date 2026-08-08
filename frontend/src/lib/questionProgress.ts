// 作答後就地補寫題目 payload 上的 `my_progress`。
//
// 單獨一個檔案而不是塞在 questionCache.ts:那支為了建 store 會 import `./api`,
// 於是整個模組在 `node --test`(純函式測試,沒有瀏覽器)底下就載不起來。純函式
// 放在它自己的模組裡,測試才拿得到,也才不必為了測兩個欄位映射去 stub fetch。

import type { QuestionFull } from "../hooks/useQuestion";

/**
 * 作答成功後,就地把 `my_progress` 補上 —— 不再為了「我剛才選了什麼」跑一趟網路。
 *
 * 舊版是 `onAnswered={reload}`:答完強制重抓整份題目 payload。那條路有兩個無聲的
 * 破口,合起來就是回報 #95 的「作答紀錄沒有保存?上一題/下一題 來回切換就不見了」:
 *
 * 1. `/api/questions/:id` 在 Service Worker 是 NetworkFirst + **3 秒 timeout**。
 *    網路一慢(e-ink 平板配弱訊號正是這個情境),回的是**答題前**存下的那份快取,
 *    `last_chosen` 還是 null —— 於是「強制重抓」反而把正確的狀態洗掉,而且它會
 *    連同 `questionCache.set()` 一起寫回應用層快取,錯得很持久。
 * 2. POST 失敗時 `onAnswered` 根本不會被呼叫,自然什麼都不會更新。
 *
 * 但 client 手上本來就有全部需要的資訊(選了哪個、對不對),不需要伺服器告訴我們。
 * 伺服器仍然是真相(同「`attempts` 是真相、`review_progress` 是快取」那條規則),
 * 下一次自然過期重抓時會覆蓋這裡算的值。
 *
 * 純函式:回新物件,不動輸入。
 */
export function withAnswer(
	q: QuestionFull,
	chosen: string,
	correct: boolean,
): QuestionFull {
	const p = q.my_progress;
	return {
		...q,
		my_progress: {
			times_seen: (p?.times_seen ?? 0) + 1,
			times_correct: (p?.times_correct ?? 0) + (correct ? 1 : 0),
			last_chosen: chosen,
			last_correct: correct ? 1 : 0,
			// 收藏跟作答是兩回事,原封不動帶過去 —— 這裡歸零的話,答一題就會把
			// 收藏取消掉(而且要重新整理才看得出來)。
			bookmarked: p?.bookmarked ?? 0,
			bookmark_folder_id: p?.bookmark_folder_id ?? null,
		},
	};
}

/** 「清除本題作答紀錄」的對應面。收藏同樣不動。 */
export function withProgressCleared(q: QuestionFull): QuestionFull {
	const p = q.my_progress;
	return {
		...q,
		my_progress: {
			times_seen: 0,
			times_correct: 0,
			last_chosen: null,
			last_correct: null,
			bookmarked: p?.bookmarked ?? 0,
			bookmark_folder_id: p?.bookmark_folder_id ?? null,
		},
	};
}

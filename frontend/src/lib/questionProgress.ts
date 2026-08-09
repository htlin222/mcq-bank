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

/**
 * 重抓回來的 payload 要不要沿用本地那份 `my_progress`。
 *
 * `withAnswer()` 把作答就地寫進快取之後,還有一條路會把它洗掉,而且位置跟直覺
 * 相反 —— 是**離開這一題的時候**,不是回來的時候。Question.tsx 在鄰居題上閒置時
 * 會預抓它自己的鄰居,剛作答那一題正好是其中之一;抓回來的 payload 被無條件
 * `set()` 進快取,蓋掉本地那份。回到這一題時 peek 直接命中被蓋過的版本,連一次
 * 網路都不會發 —— 所以從「回來時有沒有重抓」的角度永遠看不到它。
 *
 * 線上為什麼會拿到「沒有作答紀錄」的 payload:`/api/questions/:id` 在 Service
 * Worker 是 NetworkFirst + **3 秒 timeout**,弱訊號(e-ink 平板正是這個情境)下回
 * 的是答題前存下的那份快取。伺服器其實記得這次作答,但那趟請求根本沒到伺服器。
 *
 * 判準刻意收得很窄:**只有在對方沒有 `last_chosen`、而本地有的時候**才保留。
 * 伺服器有紀錄時一律以伺服器為準(times_seen 之類的統計才不會停在本地估算);
 * 使用者主動清除過的話,本地的 `last_chosen` 也已經是 null,不會把它救回來。
 * 剩下的邊界是「在另一台裝置清除紀錄」—— 那會被這裡擋住,但重新整理就會拿到
 * 伺服器的真相(整頁重載時 questionCache 是空的,沒有本地那份可以保留)。
 *
 * 純函式:回新物件,不動輸入;題目本體一律用重抓回來的那份。
 */
export function preserveLocalAnswer(
	incoming: QuestionFull,
	local: QuestionFull | undefined,
): QuestionFull {
	const mine = local?.my_progress;
	if (!mine?.last_chosen) return incoming;
	if (incoming.my_progress?.last_chosen) return incoming;
	return { ...incoming, my_progress: mine };
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

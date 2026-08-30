// 錯題回顧的排序。
//
// **白名單查表,不是把 query string 拼進 SQL。** 這一段是唯一會被使用者輸入影響
// 到 ORDER BY 的地方,而 D1 的 bind 只綁得了值、綁不了識別字 —— 拼字串就是注入。
// 查不到就退回預設,不報錯:排序壞掉不該讓整頁打不開。
//
// **每一種都以 `q.id` 收尾,湊成全序。** 同分讓 SQLite 自由決定的話,使用者看到的
// 是「每次重整清單就換位置」,而且在只有幾題的帳號上完全看不出來 —— 同
// `lib/bookmarkSort.ts` 與個人筆記排序踩過的那條。
//
// `times_seen > 0` 由呼叫端的 WHERE 保證(錯題清單的前提),所以這裡的除法不會除以 0。

export const WRONG_SORTS = ["rate", "misses", "recent", "stale", "number"] as const;

export type WrongSort = (typeof WRONG_SORTS)[number];

export const DEFAULT_WRONG_SORT: WrongSort = "rate";

const ORDER: Record<WrongSort, string> = {
	// 正確率低的在前 —— 「最不熟的先練」,這是舊行為,保持預設。
	rate: "(rp.times_correct * 100 / rp.times_seen) ASC, rp.last_seen_at DESC, q.id",
	// 答錯次數多的在前。跟 rate 不同:答 10 次錯 3 次(70%)排在答 2 次錯 1 次(50%)前面,
	// 因為那一題實際上絆倒你三次。
	misses: "(rp.times_seen - rp.times_correct) DESC, rp.last_seen_at DESC, q.id",
	recent: "rp.last_seen_at DESC, q.id",
	stale: "rp.last_seen_at ASC, q.id",
	number: "q.year DESC, q.number ASC, q.id",
};

export function isWrongSort(v: unknown): v is WrongSort {
	return typeof v === "string" && (WRONG_SORTS as readonly string[]).includes(v);
}

/** 給 ORDER BY 用的片段。未知值一律退回預設。 */
export function wrongOrderBy(sort?: string | null): string {
	return ORDER[isWrongSort(sort) ? sort : DEFAULT_WRONG_SORT];
}

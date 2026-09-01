/**
 * 命中發生在**選項**裡的時候,要在列上講出來。
 *
 * 搜尋索引涵蓋題幹 + 選項 + 標籤(見 `migrations/0005_search_fts.sql`),所以
 * 一題完全可以因為某個選項裡的字被找出來 —— 而題幹上一個標記都沒有。
 *
 * 舊版顯示的是 FTS5 的 `snippet()`,它會**標出命中在哪**,所以這件事自己會解釋。
 * 換成「整段題幹 + client 端標記」之後那個解釋沒了,畫面上只剩一列看起來莫名其妙
 * 的結果。這支就是把它補回來。
 *
 * 選項全文本來就跟著清單一起送過來(展開選項用的),所以這裡不打任何請求。
 */

export type OptionHit = { key: string; text: string };

/** 命中判斷跟 `markTerms` 一致:不分大小寫、不卡字界。 */
function contains(haystack: string, needle: string): boolean {
	return haystack.toLowerCase().includes(needle.toLowerCase());
}

/** 題幹裡有沒有命中任何一個詞。 */
export function stemHasHit(stem: string, terms: string[]): boolean {
	return terms.some((t) => t.length > 0 && contains(stem, t));
}

/**
 * 哪些選項命中了。
 *
 * **只在題幹沒有命中時才需要問這件事** —— 題幹已經標起來的話,再多一行
 * 「符合選項 C」只是重複說一次命中,而清單上每多一行都是成本。判斷留給呼叫端。
 */
export function optionHits(
	options: Record<string, string> | undefined,
	terms: string[],
): OptionHit[] {
	if (!options) return [];
	const usable = terms.filter((t) => t.length > 0);
	if (usable.length === 0) return [];
	return Object.entries(options)
		.filter(([, text]) => usable.some((t) => contains(text, t)))
		.map(([key, text]) => ({ key, text }));
}

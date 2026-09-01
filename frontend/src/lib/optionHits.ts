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
 * ⚠️ **判準是「逐個詞」,不是「整段題幹有沒有命中」。** 這一版改過:回報是
 * 「搜 `lupus erythematosus disease`,結果只有 disease 也會找到」—— 那一列的題幹
 * 確實有 `disease`(所以舊判準認為「題幹命中了,不用解釋」),而 `lupus` 與
 * `erythematosus` 落在**選項**裡。使用者看到的就是一列只有 disease 被標起來、
 * 卻不知道另外兩個字在哪的結果。空白是 AND 沒錯,但那個 AND 是**整列**的。
 *
 * 選項全文本來就跟著清單一起送過來(展開選項用的),所以這裡不打任何請求。
 */

export type OptionHit = { key: string; text: string };

/** 命中判斷跟 `markTerms` 一致:不分大小寫、不卡字界。 */
function contains(haystack: string, needle: string): boolean {
	return haystack.toLowerCase().includes(needle.toLowerCase());
}

/**
 * 哪幾個詞**不在題幹裡**。
 *
 * 這幾個就是需要解釋的 —— 它們命中在使用者看不見的地方(選項 / 標籤)。
 */
export function termsMissingFromStem(stem: string, terms: string[]): string[] {
	return terms.filter((t) => t.length > 0 && !contains(stem, t));
}

/**
 * 哪些選項命中了。
 *
 * 呼叫端只該把 `termsMissingFromStem()` 的結果傳進來 —— 題幹上已經標起來的詞
 * 再講一次只是重複,而清單上每多一行都是成本。
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

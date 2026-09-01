/**
 * 使用者輸入 → FTS5 查詢字串。
 *
 * 純函式,沒有任何 import —— 這是這個 repo 裡 `worker/**\/*.test.ts` 的前提
 * (那些測試全是純函式,`node --test` 直接載入)。搜尋語法是最需要被釘住的東西
 * 之一:它壞掉的時候不會報錯,只會**少給結果**。
 *
 * ## 逗號 = OR
 *
 * `AML, CML` → `(AML*) OR (CML*)`。半形與**全形**逗號都算 —— 中文輸入法預設打
 * 出來的是 `,`,只認半形等於在中文使用者身上完全不會生效。
 *
 * 一段之內的空白仍然是 AND(FTS5 的預設),所以 `AML M3, CML` 是
 * 「(AML 且 M3) 或 CML」—— 那也是讀起來最自然的一種。
 *
 * **只有一段時輸出跟以前一模一樣**(不加括號),沒有逗號的查詢因此一個字元都
 * 沒有變。
 *
 * ## 大小寫
 *
 * 不必在這裡處理:FTS5 的 `unicode61` tokenizer 對索引與查詢**兩側**都做 case
 * folding,所以 `aml` 與 `AML` 本來就等價(實測過)。刻意不 `toLowerCase()` ——
 * 那會把 `AND` / `OR` / `NOT` 這幾個**只有大寫才算運算子**的字變成一般詞,
 * 把一個現有的功能弄壞。
 *
 * ## 其他
 *
 * - 落單的 `"` 換成空白,免得使用者的輸入把我們自己的引號配對打斷。
 * - 純 ASCII 英數字的詞尾端加 `*`(前綴比對):`AML` 也會命中 `AML7`。
 * - 其餘(含 CJK)包成 `"..."` 片語再加 `*`。
 *   ⚠️ **這只救得到「從一段 CJK 的開頭算起」的比對。** `unicode61` 把連續的
 *   CJK 當成**一個** token,所以「白血病」比不到「慢性骨髓性白血病」——
 *   實測 `慢性*` 命中、`白血病*` 不命中。那是 tokenizer 的限制,不是這裡能修的
 *   (同 CLAUDE.md 講義那節提過的同一個老問題)。
 * - **大寫的 `AND` / `OR` / `NOT` 原樣通過**,不加 `*`。舊版對它們也加了 `*`,
 *   於是 `AML OR CML` 變成 `AML* OR* CML*` —— 那是 **FTS5 語法錯誤**
 *   (實測 `fts5: syntax error near "*"`),路由把它變成 400,使用者看到的是
 *   「搜尋失敗」。也就是說註解上寫著「運算子刻意不擋」的那個功能,其實一直是壞的。
 *   只認大寫是 FTS5 自己的規矩:小寫的 `or` 是一般的詞。
 *
 * 安全性:回傳值一律走 `.bind(?)`,所以不管輸入什麼都不可能 SQL injection。
 */
export function ftsQuery(raw: string): string {
	const groups = raw
		// 半形與全形逗號都是「或」。
		.split(/[,，]/)
		.map(ftsGroup)
		.filter((g) => g.length > 0);
	if (groups.length === 0) return "";
	// 一段時不加括號 —— 沒有逗號的查詢輸出與加這個功能之前完全相同。
	if (groups.length === 1) return groups[0];
	return groups.map((g) => `(${g})`).join(" OR ");
}

/** 一段(逗號之間)的詞:空白分開,彼此是 AND。 */
function ftsGroup(segment: string): string {
	const cleaned = segment.replace(/"/g, " ").trim();
	if (!cleaned) return "";
	return cleaned
		.split(/\s+/)
		.map((t) => {
			// FTS5 的運算子:原樣通過。加了 `*` 會變成語法錯誤(見檔頭)。
			if (t === "AND" || t === "OR" || t === "NOT") return t;
			return /^[A-Za-z0-9_]+$/.test(t) ? `${t}*` : `"${t}"*`;
		})
		.join(" ");
}

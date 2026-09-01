/**
 * 「AI 進階搜尋」:把一個關鍵字展開成一排寫法變體,交給逗號 OR 去查。
 *
 * 要解的是這個題庫上每天都在發生的事:同一個東西有好幾種寫法,而全文檢索只認
 * 字面 —— 打 `AML` 找不到寫成 `acute myeloid leukemia` 的題目,打 `body` 找不到
 * `bodies`。展開之後接上 `lib/fts-query.ts` 的逗號 OR,一次查完。
 *
 * ## 為什麼解析器要這麼囉嗦
 *
 * 模型**不會乖乖只回一行**:前面加「Here are the terms:」、改成條列、改成 JSON
 * 陣列、把說明也寫進去 —— 每一種都出現過。而這裡失敗的樣子是**把整句話當成一個
 * 搜尋詞丟進 FTS**,查出 0 筆,使用者只會覺得「AI 搜尋沒用」。所以寧可解析寬鬆、
 * 把不像詞的東西丟掉,也不要原樣相信。
 *
 * ## 原查詢永遠排第一,而且永遠不會被丟掉
 *
 * 模型可能整批答非所問。留著原查詢,最差的情況也只是退化成「跟沒按這顆按鈕
 * 一樣」,而不是「按了之後反而找不到東西」。
 */

/** 一次最多幾個詞。再多的話 OR 出來的結果會稀釋到沒有意義,而且 FTS 也變慢。 */
export const MAX_TERMS = 12;
/** 單一詞的長度上限。超過的多半是模型把說明寫了進來。 */
const MAX_TERM_LEN = 60;
/** 使用者輸入的長度上限 —— 這是丟給模型的東西,不該讓它變成貼一整段文章的入口。 */
export const MAX_QUERY_LEN = 100;

export function buildExpandSystemPrompt(): string {
	return [
		"You expand a medical exam search keyword into alternative spellings so a",
		"full-text search can match them all.",
		"Reply with ONE line: the variants separated by commas. No explanation,",
		"no numbering, no quotes, no trailing period.",
		"Include, when they apply: the abbreviation and its full name, singular and",
		"plural forms, common British/American spellings, widely used synonyms, and",
		"the Traditional Chinese term if the concept has a standard one.",
		"Keep every variant short (a term, not a sentence). At most 10 variants.",
		"Example input: AML",
		"Example output: AML, acute myeloid leukemia, acute myelogenous leukaemia, 急性骨髓性白血病",
	].join(" ");
}

/** 條列符號 / 編號 / 前後引號 —— 模型很愛加。 */
function stripDecoration(s: string): string {
	return s
		.replace(/^\s*(?:[-*•·]|\d+[.)])\s*/, "")
		.replace(/^["'「『]+|["'」』]+$/g, "")
		.trim();
}

/**
 * 看起來像不像一個「搜尋詞」。
 *
 * 這道閘擋的是模型的開場白與說明句 —— 它們一旦進了查詢,整串 OR 就會被一段
 * 永遠比不到的長句拖著,而畫面上只是「沒有結果」。
 */
function looksLikeTerm(s: string): boolean {
	if (!s || s.length > MAX_TERM_LEN) return false;
	// 句號 / 冒號 / 分號 = 那是一句話,不是一個詞。
	// 半形 `.` 也算 —— 拒絕語(「I cannot help with that.」)靠它擋下來,而術語
	// 幾乎不帶句點。代價是 `t(9;22)` 這種細胞遺傳學寫法也進不來,但那本來就不是
	// 「同一個東西的不同寫法」,不是這個功能要處理的東西。
	if (/[.。;；:：!！?？]/.test(s)) return false;
	// 英文超過 6 個字已經不是術語了(acute promyelocytic leukemia 才 3 個)。
	if (s.split(/\s+/).length > 6) return false;
	return true;
}

/**
 * 模型回應 → 乾淨的詞表。
 *
 * @param raw 模型吐出來的字串(或 `AI.run` 的整包回應)
 * @param query 使用者原本打的字 —— 一定會排在第一個
 */
export function parseExpandResponse(raw: unknown, query: string): string[] {
	const text = extractText(raw);
	const pieces = splitCandidates(text);

	const out: string[] = [];
	const seen = new Set<string>();
	// 原查詢永遠第一個,而且用它自己的原樣(不做 trim 以外的加工)。
	const first = query.trim();
	if (first) {
		out.push(first);
		seen.add(first.toLowerCase());
	}
	for (const p of pieces) {
		const t = stripDecoration(p);
		if (!looksLikeTerm(t)) continue;
		const key = t.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(t);
		if (out.length >= MAX_TERMS) break;
	}
	return out;
}

/** JSON 陣列也接 —— 模型有時候會自作主張回一包 JSON。 */
function splitCandidates(text: string): string[] {
	const trimmed = text.trim();
	if (trimmed.startsWith("[")) {
		try {
			const arr = JSON.parse(trimmed);
			if (Array.isArray(arr)) {
				return arr.filter((x): x is string => typeof x === "string");
			}
		} catch {
			/* 不是合法 JSON —— 照一般文字處理 */
		}
	}
	// 換行與逗號(半形 + 全形)都當分隔符:條列與一行式兩種格式一起吃下來。
	return text.split(/[\n,，]/);
}

/** `AI.run` 的回應形狀在不同模型之間不一致,而拿錯就是整批空的。 */
function extractText(raw: unknown): string {
	if (typeof raw === "string") return raw;
	if (raw && typeof raw === "object") {
		const r = raw as Record<string, unknown>;
		if (typeof r.response === "string") return r.response;
		if (typeof r.result === "string") return r.result;
	}
	return "";
}

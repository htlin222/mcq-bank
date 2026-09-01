/**
 * 在題幹裡標出使用者搜尋的字。
 *
 * 取代 FTS5 的 `snippet()`:那個回的是**片段**(預設 16 個 token),而題幹被切掉
 * 之後,清單上那一列常常剛好停在關鍵的那一句之前。現在整段題幹都顯示,標記交給
 * client 做 —— 反正題幹本來就整份送過來了。
 *
 * 同 `stemHighlight.ts` 的作法:**回傳片段,不回傳 HTML 字串**。題幹是匯入的
 * 資料,而這一層只是排版,沒有理由讓它有機會注入標記。
 */

export type MarkedPart = { text: string; hit: boolean };

/** 正則的元字元。使用者可以在搜尋框打任何東西,不跳脫的話會直接炸掉。 */
function escapeRe(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 把查詢字串切成「要標起來的字」。
 *
 * 逗號(半形/全形)與空白都是分隔符,**引號內是一個整體** —— 跟
 * `worker/lib/fts-query.ts` 的切法一致,所以畫面上標起來的,就是伺服器真的拿去
 * 比對的那些。少了引號那一段,`"lupus erythematosus"` 會被拆成兩個字分別標,
 * 而使用者打引號的用意正好是「這兩個字要連在一起」。
 *
 * **FTS5 的運算子要丟掉**:`AML OR CML` 裡的 `OR` 不是使用者要找的字,標起來
 * 只會讓人以為那是命中。
 */
export function queryTerms(q: string): string[] {
	const src = q.replace(/[“”„«»「」『』]/g, '"');
	const out: string[] = [];
	const re = /"([^"]*)"|([^\s,，]+)/g;
	let m = re.exec(src);
	while (m !== null) {
		const raw = m[1] !== undefined ? m[1] : m[2].replace(/["'*]/g, "");
		const t = raw.trim();
		if (t && t !== "AND" && t !== "OR" && t !== "NOT") out.push(t);
		m = re.exec(src);
	}
	return out;
}

/**
 * 把 `text` 依 `terms` 切成標記/未標記的片段。
 *
 * - **依長度由長到短組正則。** `|` 是「取第一個對得上的分支」不是取最長 ——
 *   同 `stemHighlight.ts` 那條:不排的話「acute myeloid」會在 `acute` 停下來,
 *   標出來的範圍比使用者打的還短,看起來像標錯位置。
 * - **大小寫不分**(`i` 旗標):FTS5 那邊本來就 case fold,畫面上的標記要跟它一致。
 * - **不卡字界。** 中文沒有字界,而英文這裡要的是「命中就標」——
 *   搜尋 `leuk` 標出 `leukemia` 的前四個字是對的,那正是前綴比對的行為。
 */
export function markTerms(text: string, terms: string[]): MarkedPart[] {
	const usable = terms.filter((t) => t.length > 0);
	if (usable.length === 0) return [{ text, hit: false }];

	const sorted = [...usable].sort((a, b) => b.length - a.length);
	const re = new RegExp(`(${sorted.map(escapeRe).join("|")})`, "gi");

	const out: MarkedPart[] = [];
	let last = 0;
	// `re` 是這裡新建的,所以 lastIndex 一定從 0 開始 —— 不像共用實例那樣需要
	// 手動重設(同 stemHighlight.ts 踩過的那條)。
	let m = re.exec(text);
	while (m !== null) {
		if (m.index > last) out.push({ text: text.slice(last, m.index), hit: false });
		out.push({ text: m[0], hit: true });
		last = m.index + m[0].length;
		// 零長度比對會讓迴圈停不下來。理論上 terms 都非空所以不會發生,但這裡的
		// 輸入來自使用者,不值得賭。
		if (m[0].length === 0) re.lastIndex++;
		m = re.exec(text);
	}
	if (last < text.length) out.push({ text: text.slice(last), hit: false });
	return out.length > 0 ? out : [{ text, hit: false }];
}

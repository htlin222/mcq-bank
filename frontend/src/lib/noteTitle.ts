// 筆記在切換下拉裡的名字 —— 一題可以有多則筆記,但筆記本身沒有標題欄位:
// 名字就是內文的第一行(所見即所名),改標題等於把第一行改掉。
//
// 為什麼不存一個 title 欄位:多一個欄位就多一個「標題和內文對不起來」的狀態,
// 而且使用者得多學一個「命名」動作。第一行本來就常常是 h1/h2,拿來當名字幾乎
// 不用做事。

/** 一般寬度的上限。窄螢幕用 NARROW_LEN —— 見下面 noteTitle 的說明。 */
export const NOTE_TITLE_MAX = 40;

/**
 * 窄螢幕的上限。40 個中文字在 390px 的下拉裡塞不下,CSS `truncate` 雖然不會
 * 讓它溢出,但整列會被一行字吃掉、日期那一行也被擠到看不出層次(#137)。
 *
 * 先設 20,實機看過之後改成 10 —— 20 字在 390px 上仍然佔滿整列,而下拉的作用是
 * 「認出是哪一則」,不是把標題讀完。10 個中文字足以分辨,而且右邊留得下空間給
 * 日期與刪除鈕。**這個值刻意不是 `NOTE_TITLE_MAX` 的固定比例**:兩者回答的是
 * 不同的問題(一個是「標題最長多少」,一個是「一眼認得出來要幾個字」)。
 */
export const NOTE_TITLE_NARROW = 10;

type AnyNode = { type?: string; text?: string; content?: unknown[] };

/** 走訪節點取出第一段有字的文字。表格/清單裡的第一格也算數。 */
function firstText(node: unknown): string {
	if (!node || typeof node !== "object") return "";
	const n = node as AnyNode;
	if (typeof n.text === "string" && n.text.trim()) return n.text.trim();
	if (Array.isArray(n.content)) {
		for (const child of n.content) {
			const t = firstText(child);
			if (t) return t;
		}
	}
	// 沒有文字但有內容的節點(圖片、分隔線)給個看得懂的替代名。
	if (n.type === "image") return "［圖片］";
	return "";
}

/**
 * 由 TipTap 文件推出筆記名。空筆記回 fallback,而不是空字串 —— 下拉裡出現
 * 一個沒有標籤的項目就等於點不到。
 */
export function noteTitle(
	doc: unknown,
	fallback = "未命名筆記",
	maxLen: number = NOTE_TITLE_MAX,
): string {
	const raw = firstText(doc).replace(/\s+/g, " ").trim();
	if (!raw) return fallback;
	return raw.length > maxLen ? `${raw.slice(0, maxLen)}…` : raw;
}

/** content_json 字串版本。壞掉的 JSON 一樣回 fallback,不丟例外。 */
export function noteTitleFromJson(
	json: string | undefined,
	fallback?: string,
	maxLen?: number,
): string {
	if (!json) return noteTitle(null, fallback, maxLen);
	try {
		return noteTitle(JSON.parse(json), fallback, maxLen);
	} catch {
		return noteTitle(null, fallback, maxLen);
	}
}

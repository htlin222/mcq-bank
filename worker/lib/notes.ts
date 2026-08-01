// 個人筆記的 slot —— 一題可以有多則,slot 是它們的編號(見 migration 0036)。
//
// slot 0 是「原本就有」的那則:所有沒指定 slot 的呼叫端(MCQ skill API、
// enrich-note 批次腳本、離線快取)都落在它身上,行為與加這個功能之前相同。

/** 一題最多幾則筆記。純粹是護欄:切換用的下拉選單再長也不該長成這樣。 */
export const MAX_NOTES_PER_QUESTION = 20;

/**
 * 把外部傳進來的 slot 收斂成合法整數。看不懂的一律當 0 —— 筆記是使用者自己
 * 的東西,寧可寫回第一則讓他看得見,也不要因為一個壞參數就靜靜丟掉。
 */
export function parseSlot(v: unknown): number {
	const n = typeof v === "number" ? v : Number(v);
	return Number.isInteger(n) && n >= 0 && n < MAX_NOTES_PER_QUESTION ? n : 0;
}

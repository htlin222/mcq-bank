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

/** 決定一次寫入落在哪一則的結果。失敗帶著 HTTP 狀態,呼叫端直接回它。 */
export type SlotPick =
	| { ok: true; slot: number; isNew: boolean }
	| { ok: false; status: 404 | 409; error: string; slots: number[] };

/**
 * 決定一次筆記寫入該落在哪一則。給 MCQ skill API 用 —— 那邊的 slot 是使用者
 * 手打的,不能像 parseSlot() 那樣把看不懂的值默默收斂成 0(會把內容灌進別則)。
 *
 * @param slots  這一題現有的 slot 號碼(順序不拘)
 * @param asked  `"new"` 另開一則;數字指定那一則;`null` 沒指定 → 第一則
 */
export function resolveNoteSlot(
	slots: number[],
	asked: number | "new" | null,
): SlotPick {
	if (asked === "new") {
		if (slots.length >= MAX_NOTES_PER_QUESTION)
			return { ok: false, status: 409, error: "too many notes", slots };
		// 號碼取最大值 +1、不重用刪掉的 —— 畫記(anno:note:<qid>:<slot>)與挖空
		// 快取都以 slot 定位,重用會讓新筆記繼承上一則的標記。
		const slot = slots.length ? Math.max(...slots) + 1 : 0;
		if (slot >= MAX_NOTES_PER_QUESTION)
			return { ok: false, status: 409, error: "slot range exhausted", slots };
		return { ok: true, slot, isNew: true };
	}

	if (asked !== null) {
		if (slots.includes(asked)) return { ok: true, slot: asked, isNew: false };
		// 一則都還沒有的時候,第 0 則是「還沒建立」而不是「找錯了」。
		if (asked === 0 && !slots.length) return { ok: true, slot: 0, isNew: true };
		return { ok: false, status: 404, error: "note slot not found", slots };
	}

	return slots.length
		? { ok: true, slot: Math.min(...slots), isNew: false }
		: { ok: true, slot: 0, isNew: true };
}

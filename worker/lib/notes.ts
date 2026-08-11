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

/** 重排的結果。失敗帶著 HTTP 狀態,呼叫端直接回它。 */
export type ReorderPick =
	| { ok: true; slots: number[] }
	| { ok: false; status: 400; error: string };

/**
 * 收斂一次「重新排序」的請求(#140)。
 *
 * 判準是**必須是現有 slot 的排列** —— 少一個、多一個、重複、夾帶不屬於這一題的
 * 號碼,一律整批拒絕。放行部分正確的請求會寫出一份「有些筆記排過、有些沒有」的
 * 順序,而那在畫面上看起來只是「排錯了」,使用者不會知道是請求壞掉。
 *
 * @param existing 這一題現有的 slot(順序不拘)
 * @param asked    使用者想要的順序
 */
export function resolveNoteOrder(
	existing: number[],
	asked: unknown,
): ReorderPick {
	if (!Array.isArray(asked)) return { ok: false, status: 400, error: "slots must be an array" };
	const slots = asked.map((v) => (typeof v === "number" ? v : Number(v)));
	if (slots.some((n) => !Number.isInteger(n)))
		return { ok: false, status: 400, error: "slots must be integers" };
	if (new Set(slots).size !== slots.length)
		return { ok: false, status: 400, error: "duplicate slots" };
	if (slots.length !== existing.length)
		return { ok: false, status: 400, error: "slots must list every note exactly once" };
	const have = new Set(existing);
	if (slots.some((n) => !have.has(n)))
		return { ok: false, status: 400, error: "unknown slot" };
	return { ok: true, slots };
}

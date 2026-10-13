/**
 * 抹片個人筆記的重排(#249)。
 *
 * 必須是這一診斷現有筆記 id 的完整排列。少一個、多一個、重複、夾帶別人的
 * id,整批拒絕。放行一部分會寫出「有些排過、有些沒有」的順序,畫面上看起來
 * 只是排錯了。
 *
 * id 本身不當排序鍵:畫記與內文都靠它定位。呼叫端只拿這份排列去寫
 * sort_order,不改 id。
 */
export function resolveSmearNoteOrder(
	existing: string[],
	asked: unknown,
): { ok: true; ids: string[] } | { ok: false; status: 400; error: string } {
	if (!Array.isArray(asked)) return { ok: false, status: 400, error: "ids must be an array" };
	if (asked.some((v) => typeof v !== "string" || v.length === 0)) {
		return { ok: false, status: 400, error: "ids must be strings" };
	}
	const ids = asked as string[];
	if (new Set(ids).size !== ids.length) {
		return { ok: false, status: 400, error: "duplicate ids" };
	}
	if (ids.length !== existing.length) {
		return { ok: false, status: 400, error: "ids must list every note exactly once" };
	}
	const have = new Set(existing);
	if (ids.some((id) => !have.has(id))) {
		return { ok: false, status: 400, error: "unknown id" };
	}
	return { ok: true, ids };
}

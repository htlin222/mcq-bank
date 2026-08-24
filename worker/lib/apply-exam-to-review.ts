// 「把這次模擬考的結果登記進複習進度」要動哪幾題。純函式,不碰 D1。
//
// 規則刻意是**只登記考對的**:複習紀錄因此是「目前最好的狀態」,不會因為一次
// 考差就把以前答對的紀錄拉下來。反過來(對錯都覆蓋)語意比較單純,但那會讓
// 「我明明弄懂過」變成看不見 —— 這個站的複習進度是拿來決定「還要不要再練」的,
// 不是作答流水帳(流水帳在 `attempts`)。

export interface ExamAnswerRow {
	question_id: string;
	chosen: string | null;
	is_correct: 0 | 1 | null;
	/** review_progress.last_chosen,沒有那一列時是 null。 */
	review_last_chosen: string | null;
}

export interface ApplyPlan {
	/** 要寫入 review_progress 的。 */
	apply: { question_id: string; chosen: string }[];
	/** 考錯或沒作答 —— 依規則不動。 */
	skipped_wrong: number;
	/** 複習紀錄已經是同一個答案,寫了也不會變。 */
	skipped_already: number;
	/** 指定了但不屬於這場考試的題號。 */
	unknown: number;
}

/**
 * @param rows      這場考試的作答(已 join review_progress.last_chosen)
 * @param requested 只處理這幾題;省略 = 整場批次
 *
 * `skipped_already` 單獨計數而不是併進 apply:批次按鈕上的數字要是「按下去會
 * 改變幾題」,把已經一樣的算進去,使用者會按完發現數字沒動。
 */
export function planApplyToReview(
	rows: readonly ExamAnswerRow[],
	requested?: readonly string[],
): ApplyPlan {
	const plan: ApplyPlan = {
		apply: [],
		skipped_wrong: 0,
		skipped_already: 0,
		unknown: 0,
	};
	const want = requested && requested.length > 0 ? new Set(requested) : null;
	const inSession = new Set(rows.map((r) => r.question_id));

	if (want) {
		for (const id of want) if (!inSession.has(id)) plan.unknown++;
	}

	for (const r of rows) {
		if (want && !want.has(r.question_id)) continue;
		if (r.is_correct !== 1 || !r.chosen) {
			plan.skipped_wrong++;
			continue;
		}
		if (r.review_last_chosen === r.chosen) {
			plan.skipped_already++;
			continue;
		}
		plan.apply.push({ question_id: r.question_id, chosen: r.chosen });
	}
	return plan;
}

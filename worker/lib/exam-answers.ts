// 交卷前那一趟全量補送要寫什麼。純函式,不碰 D1 —— 抽出來才驗得到,而這段的
// 難處全在邊界(沒變的、不屬於這場考試的、型別不對的、同一題送兩次的)。
//
// 背景:舊版前端在交卷時逐題 POST `/answer`,100 題就是 100 趟循序往返,正式機
// 實測每趟 1.30 秒 —— 交卷因此要等兩分鐘以上。現在壓成一趟,由這裡決定其中哪
// 幾條真的要寫。

export interface IncomingAnswer {
	question_id?: unknown;
	chosen?: unknown;
}

export interface AnswerWrite {
	question_id: string;
	chosen: string;
}

export interface AnswerPlan {
	/** 真的要寫入(且 append 一筆 attempt)的答案。 */
	writes: AnswerWrite[];
	/** 與庫裡相同,不寫。 */
	unchanged: number;
	/** 不屬於這場考試的題號。 */
	unknown: number;
	/** 型別不對(缺欄位、不是字串)。 */
	invalid: number;
}

/**
 * @param incoming client 送來的全量答案(未經驗證)
 * @param stored   這場考試目前的答案,question_id → chosen(未作答是 null)
 *
 * **判準是「答案跟庫裡不一樣」,不是「有沒有送來」。** 交卷時送來的 100 題裡,
 * 99 題在作答當下就已經寫過了 —— 舊路徑對它們全部 append 一筆 attempt,於是
 * 一場考試在 `attempts`(全站作答真相)裡多出 100 筆 elapsed_ms 為 NULL 的重複
 * 列。舊程式自己的註解就寫著「這不是一次新的作答事件」,卻仍把它記成事件。
 */
export function planAnswerWrites(
	incoming: readonly IncomingAnswer[],
	stored: ReadonlyMap<string, string | null>,
): AnswerPlan {
	const plan: AnswerPlan = { writes: [], unchanged: 0, unknown: 0, invalid: 0 };
	// 同一題送兩次時後者覆蓋前者,而且只算一次 —— 讓 batch 裡不會有兩條互相
	// 打架的 UPDATE。誰贏由這裡決定,不要交給 SQL 的執行順序。
	const seen = new Map<string, number>();

	for (const a of incoming) {
		const qid = typeof a?.question_id === 'string' ? a.question_id : null;
		const chosen = typeof a?.chosen === 'string' ? a.chosen : null;
		if (!qid || !chosen) {
			plan.invalid++;
			continue;
		}
		if (!stored.has(qid)) {
			plan.unknown++;
			continue;
		}
		if (stored.get(qid) === chosen) {
			plan.unchanged++;
			continue;
		}
		const at = seen.get(qid);
		if (at === undefined) {
			seen.set(qid, plan.writes.length);
			plan.writes.push({ question_id: qid, chosen });
		} else {
			plan.writes[at] = { question_id: qid, chosen };
		}
	}
	return plan;
}

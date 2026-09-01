import { optionsToRecord } from "./db";

/**
 * 清單頁那一列的共同形狀。
 *
 * 成績頁、錯題回顧、搜尋、弱點地圖四個端點都要餵同一組前端元件
 * (`AnswerOptions` / `AnswerVerdict`),而那組元件吃的是 `options` 與
 * **`correct_answer`** —— 不是 `options_json` 與 `answer`。
 *
 * ⚠️ **欄名對齊是承重的,不是整潔。** 四邊各自手抄一次的話,漏掉一個
 * `AS correct_answer` 的症狀是「那一頁展開選項後每一列都沒有標正解」——
 * 不會報錯,而且只有展開才看得到。所以 SELECT 片段與轉換各只有一份。
 *
 * 選項全文**跟著清單一起回來**(而不是展開時再抓):200 列的選項是幾十 KB,
 * 而懶載入的代價是每展開一題就一趟 RTT。分布(`/stats`)才是真的每題一趟,
 * 那個仍然懶載入。
 */

/** SELECT 片段。呼叫端的 `questions` 必須別名為 `q`。 */
export const QUESTION_ROW_COLUMNS = `q.id, q.year, q.number, q.stem, q."group", q.options_json, q.answer`;

export type QuestionRowRaw = { options_json: string; answer: string };

/** `options_json` / `answer` → `options` / `correct_answer`,其餘欄位原樣帶過。 */
export function toQuestionRow<T extends QuestionRowRaw>({
	options_json,
	answer,
	...rest
}: T): Omit<T, "options_json" | "answer"> & {
	options: Record<string, string>;
	correct_answer: string;
} {
	return {
		...rest,
		options: optionsToRecord(options_json),
		correct_answer: answer,
	};
}

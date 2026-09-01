/**
 * 清單頁那一列的形狀 —— 前端這一側。
 *
 * 成績頁、錯題回顧、搜尋、弱點地圖四頁都把這種列餵進同一組元件
 * (`AnswerOptions` / `AnswerVerdict` / `QuestionRowActions`)。伺服器那一側的
 * 對應物是 `worker/lib/question-row.ts` —— **欄名一致是承重的**,而不是整潔:
 * 漏掉一個 `correct_answer` 的症狀是「那一頁展開選項後沒有標正解」,不報錯,
 * 而且只有展開才看得到。
 *
 * 每一頁還有自己的欄位(搜尋的 `snippet`、錯題回顧的 `times_correct`),所以是
 * 交集不是全集 —— 各頁用 `&` 疊自己的。
 */
export type QuestionListRow = {
	id: string;
	year: number;
	number: number;
	stem: string;
	group: string | null;
	/** 選項全文,字母 → 內容。跟清單一起回來,所以展開是即時的。 */
	options?: Record<string, string>;
	correct_answer?: string;
	/** 複習進度記著的答案 —— 檢討時真正要知道的是「我當初選了哪一個」。 */
	last_chosen?: string | null;
	times_seen?: number | null;
	last_correct?: number | null;
};

/**
 * 一列的稱呼:`113-050`。
 *
 * **不是題號數字。** 這幾頁都跨年份,單獨一個 `50` 指不到任何一題 ——
 * `ExplanationPeek` 的標題與 `QuestionRowActions` 的 aria-label 都吃這個。
 */
export function rowTitle(r: { year: number; number: number }): string {
	return `${r.year}-${String(r.number).padStart(3, "0")}`;
}

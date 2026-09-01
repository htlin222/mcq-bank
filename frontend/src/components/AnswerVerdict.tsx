/**
 * 一列上的「我答得如何」:`✓ B` / `✗ 你選 B · 正解 A` / `未作答 · 正解 A`。
 *
 * 三個清單頁都要說同一件事(成績頁、錯題回顧、搜尋),而**說法一致比說法漂亮
 * 重要**:同一個人在三頁之間切換,看到三種寫法會以為那是三種不同的狀態。
 *
 * **語意不只靠顏色。** emerald/rose 在 e-ink 的 1-bit 下會塌成同一種,所以對錯
 * 是由 `✓` / `✗` 這兩個字元承載的 —— 顏色只是加強。同 CLAUDE.md 電子紙那節
 * 「顏色沒了之後,語意要換一個維度重講」。
 */
export function AnswerVerdict({
	chosen,
	correctAnswer,
	correct,
	seen = false,
}: {
	/** 這個人上次選了哪一個。null = 沒有這筆紀錄。 */
	chosen: string | null;
	correctAnswer: string;
	/** 上次那一答是不是對的。 */
	correct: boolean;
	/**
	 * 有作答紀錄、但不知道選了哪一個(`last_chosen` 尚未存在時留下的舊列)。
	 *
	 * 少了這個旗標,那種列會被畫成「未作答」—— 而**那是說謊**,不是少講一點:
	 * 使用者會以為自己從沒寫過這題。
	 */
	seen?: boolean;
}) {
	if (chosen) {
		return correct ? (
			<span className="text-emerald-700 dark:text-emerald-400">✓ {chosen}</span>
		) : (
			<span className="text-rose-700 dark:text-rose-400">
				✗ 你選 {chosen} · 正解 {correctAnswer}
			</span>
		);
	}
	if (seen) {
		return correct ? (
			<span className="text-emerald-700 dark:text-emerald-400">✓ 答對</span>
		) : (
			<span className="text-rose-700 dark:text-rose-400">
				✗ 答錯 · 正解 {correctAnswer}
			</span>
		);
	}
	return <span>未作答 · 正解 {correctAnswer}</span>;
}

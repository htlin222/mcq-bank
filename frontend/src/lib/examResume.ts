// 續考時該落在哪一題。
//
// 全真作答會被暫停、關分頁、換裝置,回來時舊版一律從**第一題**開始 —— 而那一題
// 多半早就答過了。使用者得自己往後翻到還沒答的地方,100 題的話那是一段完全沒有
// 必要的翻頁,而且很容易翻過頭又漏掉中間跳過的題目。
//
// 判準是「第一個沒有作答紀錄的題目」,兩個來源都算數:
//   - `chosen` —— 伺服器記得的答案(換裝置、重新整理都拿得到)
//   - `answers` —— 本機這一輪的作答(離線時只存在這裡,還沒送上去)
// 少看其中一邊的症狀都是「明明答過了,卻停在那一題」。
//
// **全部答完時回 0,不是最後一題。** 那時使用者要做的是檢查與交卷,而第一題是
// 唯一可預測的起點;停在最後一題會讓人以為自己剛剛在那裡作答過。

export type ResumeQuestion = { id: string; chosen?: string | null };

export function resumeIdx(
	questions: ResumeQuestion[],
	answers: Record<string, string | undefined> = {},
): number {
	const i = questions.findIndex((q) => !answers[q.id] && !q.chosen);
	return i >= 0 ? i : 0;
}

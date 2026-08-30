// 錯題回顧的排序選項(畫面這一側)。
//
// **值必須跟 `worker/lib/wrong-sort.ts` 的白名單一模一樣** —— 送出去的是字串,
// 對不上的話伺服器會靜靜退回預設排序,而畫面上的下拉還顯示著使用者選的那一項。
// 那種不一致沒有任何錯誤訊息,只會讓人覺得「排序有時候有效有時候沒效」。
// 兩邊各一份的理由:worker 那份不能被前端 bundle 進來(它帶 SQL 片段),而這裡
// 要的是給人看的字。有一條測試釘著兩份的鍵完全一致。
//
// 標籤是句子的一部分(「複習模式中答錯的題目,{標籤}」),所以不寫成名詞短語。

export const WRONG_SORT_LABELS = {
	rate: "按錯誤率排序",
	misses: "按答錯次數排序",
	recent: "最近做過的排前面",
	stale: "最久沒做的排前面",
	number: "按題號排序",
} as const;

export type WrongSort = keyof typeof WRONG_SORT_LABELS;

export const DEFAULT_WRONG_SORT: WrongSort = "rate";

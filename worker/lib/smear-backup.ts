// 抹片作答的備份游標。一頁可能在一場的中間切開(一場最多 200 題,頁面
// 預設也是 200)。若游標只記 session_id,下一頁用 `session_id > ?` 會把
// 這一場剩下的題整段丟掉。所以一列一個游標,分隔符是換行 —— SQL 端要寫
// `(a.session_id || char(10) || a.question_id) > ?`,跟這裡同一個字元。

export function smearAnswerCursor(sessionId: string, questionId: string): string {
	return `${sessionId}\n${questionId}`;
}

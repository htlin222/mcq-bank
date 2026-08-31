import type { ChatMessage } from './ChatProvider.tsx';

/**
 * 把一則訊息就地換成墓碑,**並且把它散在別處的副本一起抹掉**。
 *
 * 這支單獨存在(而不是寫在 ChatProvider 的 switch 裡)是因為它要回答的問題不是
 * 「怎麼改 state」,而是**「這則訊息的內容還有幾份」** —— 而漏掉任何一份的症狀
 * 都一樣:使用者按了撤回,字還在。伺服器那側是同一組動作
 * (`worker/chat-room.ts` 的 `handleRecall`),兩邊要對得起來。
 *
 * 目前有兩份:
 *
 *   1. 訊息本身的 `text`。
 *   2. **每一則引用它的回覆裡的 `reply_snippet`** —— 回覆是去正規化的快照
 *      (刻意的:被引用的訊息可能早就被 trim 掉了),所以同一段文字在畫面上
 *      可能有好幾份。
 *
 * (第三份在 D1 的 `notifications.preview`,那個只有伺服器碰得到。)
 *
 * `reply_snippet` 抹成 **null 而不是空字串**:`reply_to` 非 null 而快照是 null,
 * 這個組合唯一的來源就是「被引用的那則撤回了」—— MessageItem 靠它畫出
 * 「訊息已撤回」,不必再多一個欄位。
 */
export function applyRecall(
	messages: ChatMessage[],
	id: number,
	deletedAt: number,
): ChatMessage[] {
	return messages.map((m) => {
		if (m.id === id) {
			return {
				...m,
				text: '',
				mentions: '[]',
				mention_all: 0,
				// 墓碑不再引用任何人:整顆泡泡都換掉了,留著引用區只會多一行沒有
				// 內容可看的東西。
				reply_to: null,
				reply_name: null,
				reply_snippet: null,
				deleted_at: deletedAt,
			};
		}
		if (m.reply_to === id) return { ...m, reply_snippet: null };
		return m;
	});
}

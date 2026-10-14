/**
 * 抹片複習模式的拼字提示旗標。看選項(`mc_choice`)與直接看答案
 * (`reveal_answer`)走別的路徑,不進這裡。
 *
 * 兩個都用過時固定寫 `initial,topic` —— 欄位註解(migrations/0043)就是這個
 * 順序。換成 `topic,initial` 之後的統計會把同一件事算成兩種。
 */
export function spellingHintUsed(opts: {
	topic: boolean;
	initial: boolean;
}): string | undefined {
	if (opts.initial && opts.topic) return "initial,topic";
	if (opts.initial) return "initial";
	if (opts.topic) return "topic";
	return undefined;
}

/**
 * 畫面上只准出現一個字母。伺服器若把整段詞回過來,當成失敗、一個字都不畫
 * —— 複習提示的價值是少給一點,不是把正解貼進 DOM。
 */
export function acceptInitial(raw: string): string | null {
	const chars = [...raw];
	if (chars.length !== 1) return null;
	if (!/\p{L}/u.test(chars[0])) return null;
	return chars[0];
}

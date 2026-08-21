// 選字工具列上哪些動作該亮 —— 抽成純函式,才測得到。
//
// 三個動作的條件互相獨立:一段兩個字的中文選取可以畫記但查不了參考資料,
// 一段在留言區的長句可以查參考資料但不能畫記。工具列因此是「逐動作 gating」,
// 不是全有全無。

/** 「查參考資料」的下限。低於這個長度,FTS 查詢只會回空手。 */
export const LOOKUP_MIN_LEN = 3;

/**
 * 「複製成圖卡」的上限。
 *
 * 不是隨手挑的數字:實測 480 字時字級已降到階梯下限,卡片高度約為寬度的 0.7 倍;
 * 再長下去只能繼續把卡片拉高,而超過一個螢幕的圖在聊天室裡沒有人會讀完。
 * **刻意不做截斷 + `…`** —— 這是題庫,截掉的醫學敘述可能意思相反
 * (「ADAMTS13 活性低於 10%」截成「ADAMTS13 活性低於 1」),寧可按鈕不出現。
 */
export const CARD_MAX_LEN = 480;

// 一段選取要有實詞才值得查:≥2 個拉丁字母(AML、CD20)或 ≥1 個漢字。
// 純標點、純數字、純空白查了也是空的。
export function hasMeaningfulContent(text: string): boolean {
	const latin = text.match(/[a-zA-Z]/g)?.length ?? 0;
	const cjk = text.match(/[㐀-鿿豈-﫿]/g)?.length ?? 0;
	return latin >= 2 || cjk >= 1;
}

export type ActionContext = {
	text: string;
	/** 選取是否落在某個已註冊的 AnnotatableContent 裡。 */
	inAnnotatable: boolean;
	/** 防劇透(cloze)模式中不開放畫記 —— 那時點擊是用來揭曉空格的。 */
	cloze: boolean;
	/** 目前在某題的頁面上(訊息要帶「$year 第 $q 題」與該題連結)。 */
	onQuestionPage: boolean;
	/** 這個帳號已綁 Telegram。沒綁時整顆按鈕不存在。 */
	telegramLinked: boolean;
};

export type Actions = {
	highlight: boolean;
	lookup: boolean;
	ai: boolean;
	telegram: boolean;
	copyImage: boolean;
};

/**
 * 決定工具列上三顆按鈕各自要不要出現。
 *
 * 注意「螢光標記」的門檻是 1 個字,不是查參考資料的 3 個字:中文兩字詞
 * (貧血、溶血)太常見,沿用 3 等於偷偷砍掉兩字詞的畫記能力。
 */
export function selectionActions(ctx: ActionContext): Actions {
	const text = ctx.text.trim();
	if (!text)
		return {
			highlight: false,
			lookup: false,
			ai: false,
			telegram: false,
			copyImage: false,
		};
	return {
		highlight: ctx.inAnnotatable && !ctx.cloze,
		lookup: text.length >= LOOKUP_MIN_LEN && hasMeaningfulContent(text),
		// AI 永遠可按 —— 沒設金鑰時由工具列引導去設定,而不是把按鈕藏起來
		// 讓使用者永遠不知道有這個功能。
		ai: true,
		// 「存到 Telegram」與 AI 相反,沒綁定就整顆藏起來:綁定流程在別的頁
		// (個人 → Telegram 推播),在浮動工具列上引導不了,留著只會是一顆
		// 按下去必定失敗的按鈕。訊息要帶題目出處,所以也只在題目頁出現。
		telegram: ctx.telegramLinked && ctx.onQuestionPage,
		// 圖卡的門檻與查參考資料一致(太短的選取畫出來只是一張大字報),
		// 但另外設上限:超過就算縮到字級下限也讀不動,見 CARD_MAX_LEN。
		copyImage:
			text.length >= LOOKUP_MIN_LEN &&
			text.length <= CARD_MAX_LEN &&
			hasMeaningfulContent(text),
	};
}

/**
 * 抓選取所在的段落文字,當作送給模型的 `{{context}}`。
 *
 * 從選取的共同祖先往上走到最近的區塊元素。找不到、或段落根本就等於選取本身
 * 時回傳空字串,由 renderPrompt 降級處理。
 */
const BLOCK_TAGS = new Set([
	"P",
	"LI",
	"TD",
	"TH",
	"BLOCKQUOTE",
	"H1",
	"H2",
	"H3",
	"H4",
	"H5",
	"H6",
	"DD",
	"DT",
	"FIGCAPTION",
]);

const MAX_CONTEXT = 800;

export function blockContext(node: Node | null, selectionText: string): string {
	let el: Element | null =
		node instanceof Element ? node : (node?.parentElement ?? null);
	while (el && !BLOCK_TAGS.has(el.tagName)) el = el.parentElement;
	if (!el) return "";
	const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
	if (!text || text === selectionText.trim()) return "";
	return text.length > MAX_CONTEXT ? `${text.slice(0, MAX_CONTEXT)}…` : text;
}

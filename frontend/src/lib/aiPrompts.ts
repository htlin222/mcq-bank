// 選字工具列「✨ AI」用的提示詞:內建清單與變數展開。
//
// 這個模組刻意不碰網路 —— 雲端 CRUD 在 aiPromptsApi.ts。分開是為了讓
// renderPrompt 能用 `node --test` 直接測(和 highlightSync / highlightStore
// 的切法一致)。
//
// 兩種來源:
//   1. 內建四則 —— 寫死在這裡,不進 D1。沒有 seed 就沒有「還原預設」這種
//      狀態要維護,也不會每個使用者複製四份一模一樣的列。
//   2. 使用者自訂 —— 存在雲端(/api/ai/prompts),跨裝置共用。
//
// 金鑰不在這裡:見 groq.ts,那是純 localStorage 的東西。

export type AiPrompt = {
	id: string;
	title: string;
	body: string;
	builtin: boolean;
};

export type ServerPrompt = {
	id: string;
	title: string;
	body: string;
	sort_order: number;
	created_at: number;
	updated_at: number;
};

const SYSTEM_PROMPT =
	"你是台灣血液腫瘤專科考試的讀書夥伴。用繁體中文(台灣用語)回答," +
	"專有名詞保留英文原文。簡潔,不要客套開場白。";

export function systemPrompt(): string {
	return SYSTEM_PROMPT;
}

export const BUILTIN_PROMPTS: AiPrompt[] = [
	{
		id: "builtin:eli5",
		title: "ELI5",
		builtin: true,
		body:
			"請把下面這段內容解釋給一個完全沒有醫學背景的人聽。多用日常生活的比喻," +
			"不要堆疊專有名詞;真的必須用到專有名詞時,先用白話講一次再附上原文。\n\n" +
			"段落脈絡:{{context}}\n\n要解釋的是:{{selection}}",
	},
	{
		id: "builtin:mnemonic",
		title: "助記",
		builtin: true,
		body:
			"請為下面這個概念設計 2-3 個好記的記憶法,中英文皆可 —— 口訣、諧音、" +
			"首字母縮寫都行。每個都要說明它怎麼對應到原本的內容,並標出最容易記混的地方。\n\n" +
			"段落脈絡:{{context}}\n\n要記的是:{{selection}}",
	},
	{
		id: "builtin:outline",
		title: "大綱",
		builtin: true,
		body:
			"請把下面這段內容拆成階層式條列,標出上位概念與其從屬關係。" +
			"層級不超過三層,每一條盡量精簡成一行。\n\n" +
			"段落脈絡:{{context}}\n\n要整理的是:{{selection}}",
	},
	{
		id: "builtin:exam",
		title: "必考重點",
		builtin: true,
		body:
			"請以台灣血液腫瘤專科考試出題者的角度,列出下面這段內容最可能被考的點," +
			"以及考生常踩的陷阱與易混淆的鑑別。每一點註明為什麼它會被考。\n\n" +
			"段落脈絡:{{context}}\n\n要分析的是:{{selection}}",
	},
];

// ── 變數替換 ──

const SELECTION_VAR = /\{\{\s*selection\s*\}\}/g;
const CONTEXT_VAR = /\{\{\s*context\s*\}\}/g;

/**
 * 把提示詞的 body 展開成真正要送給模型的 user message。
 *
 * `{{selection}}` / `{{context}}` 會被替換掉。兩個都沒寫時,自動把選取文字
 * 附在結尾 —— 使用者很容易寫了一段指示卻忘記插變數,那樣模型會收到一句
 * 沒有受詞的空話,寧可多附一次也不要送出無意義的請求。
 *
 * `{{context}}` 取不到(選取不在任何區塊內、或段落與選取完全相同)時降級成
 * 選取文字本身,而不是留一個空洞的「段落脈絡:」。
 */
export function renderPrompt(
	body: string,
	vars: { selection: string; context?: string },
): string {
	const selection = vars.selection;
	const context = vars.context?.trim() || selection;

	const hasSelection = SELECTION_VAR.test(body);
	const hasContext = CONTEXT_VAR.test(body);
	// test() 會推進 lastIndex(g flag),replace 前必須歸零。
	SELECTION_VAR.lastIndex = 0;
	CONTEXT_VAR.lastIndex = 0;

	const filled = body
		.replace(SELECTION_VAR, selection)
		.replace(CONTEXT_VAR, context);

	if (hasSelection || hasContext) return filled;
	return `${filled}\n\n${selection}`;
}


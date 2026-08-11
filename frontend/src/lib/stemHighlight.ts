/**
 * 題幹裡的「否定詞」—— 標紅加粗,免得整題讀完才發現問的是「何者錯誤」(#149)。
 *
 * ⚠️ 這支**不能 import 任何東西**(要能在 `node --test` 底下單獨載入)。
 *
 * ## 詞表為什麼是這幾個
 *
 * 逐個在題庫裡數過(1100 題):
 *
 *     wrong 245 · 錯誤 69 · incorrect 42 · except 38 · 為非 31 · 不正確 29 · false 5
 *
 * 抽樣看過 `wrong` 的上下文,全是「Which statement is wrong about …」,沒有誤命中。
 *
 * `is not` 是後來補的(59 題,抽樣全是 is NOT likely / necessary / indicated /
 * correct 這種問句骨架)。它跟單獨的 `not` 不同 —— 後者「is not associated」是
 * 選項的日常用語。
 *
 * **刻意不收的**:單獨的「非」(非何杰金氏淋巴瘤、非典型…,幾乎每頁都有)與單獨的
 * `not`。這一層的價值來自**稀有** —— 詞表一長就沒有作用了,所以測試除了「有標到」
 * 也守著「不該標的沒被標到」。
 */

/** 拉丁字要卡字界(`wrongly`、`exception` 不算);中日韓沒有字界,直接比子字串。 */
const LATIN = [
	"incorrect",
	"wrong",
	"except",
	"false",
	// `is not` 在題幹裡 59 題,抽樣看下來全是真的否定問句(is NOT likely /
	// necessary / indicated / correct / considered / classified)。它跟一開始被
	// 排除的**單獨** `not` 不同 —— 「is not」幾乎只出現在問句的骨架上,而
	// 「not associated」那種是選項的日常用語(而這一層只掛在題幹上)。
	"is not true",
	"not true",
	"is not",
	// 題庫裡剛好一題(112-049「Which kind of agent has no evidence of clinical
	// benefit…?」),是真的否定問句。**它的近親 `without evidence` 不能加** ——
	// 112-031 的「ADAMTS13 activity 68%, without evidence for an antibody
	// inhibitor」是臨床描述,標起來會讓人以為那句是題目的陷阱所在。
	// 這一組是判斷「該不該收一個詞」的樣板:看它出現在**問句骨架**上還是
	// 出現在**病歷敘述**裡,而不是看它像不像否定。
	"no evidence",
];
const CJK = ["錯誤", "不正確", "為非", "何者非"];

/** 一段題幹切成「要不要標起來」的片段。順序即原文,串起來等於原字串。 */
export type StemPart = { text: string; hit: boolean };

// **長的排前面。** 正則的 `|` 是「在目前位置取第一個match得上的分支」,不是取最長 ——
// 不排的話「is not true」會在 `is not` 那一支就停下來,標成「is not」+ 沒標的
// 「true」。排序放在這裡而不是要求詞表手動維護順序:那種順序沒有人看得出來為什麼,
// 加一個詞就可能靜靜地破壞另一個。
const byLengthDesc = (a: string, b: string) => b.length - a.length;

const PATTERN = new RegExp(
	[
		// \b 對拉丁字有效;詞裡的空白允許多個(官方題幹排版有時會多一格)。
		`\\b(?:${[...LATIN]
			.sort(byLengthDesc)
			.map((w) => w.replace(/ /g, "\\s+"))
			.join("|")})\\b`,
		[...CJK].sort(byLengthDesc).join("|"),
	].join("|"),
	"giu",
);

/**
 * 切開題幹。回傳片段而不是 HTML 字串 —— 呼叫端用 React 節點渲染,不必碰
 * `dangerouslySetInnerHTML`(題幹是使用者匯入的資料,而這一層只是排版)。
 */
export function splitNegations(stem: string): StemPart[] {
	const parts: StemPart[] = [];
	let last = 0;
	// 每次呼叫重設 —— `g` 旗標的 lastIndex 是掛在正則物件上的,共用同一個實例時
	// 第二次呼叫會從上次結束的位置開始找,結果隨呼叫順序改變。
	PATTERN.lastIndex = 0;
	for (let m = PATTERN.exec(stem); m; m = PATTERN.exec(stem)) {
		if (m.index > last) parts.push({ text: stem.slice(last, m.index), hit: false });
		parts.push({ text: m[0], hit: true });
		last = m.index + m[0].length;
		// 零長度比對會無限迴圈。詞表裡不會有,但正則是可以被改壞的。
		if (m[0].length === 0) PATTERN.lastIndex++;
	}
	if (last < stem.length) parts.push({ text: stem.slice(last), hit: false });
	return parts;
}

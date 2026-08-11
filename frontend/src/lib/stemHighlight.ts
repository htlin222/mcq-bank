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
 * **刻意不收的**:單獨的「非」(非何杰金氏淋巴瘤、非典型…,幾乎每頁都有)、
 * 單獨的 `not`(「is not associated」是選項的日常用語,標起來滿頁都是紅的,
 * 反而讓真正的否定問句消失在雜訊裡)。這一層的價值來自**稀有**——
 * 詞表一長就沒有作用了。
 */

/** 拉丁字要卡字界(`wrongly`、`exception` 不算);中日韓沒有字界,直接比子字串。 */
const LATIN = ["incorrect", "wrong", "except", "false", "not true"];
const CJK = ["錯誤", "不正確", "為非", "何者非"];

/** 一段題幹切成「要不要標起來」的片段。順序即原文,串起來等於原字串。 */
export type StemPart = { text: string; hit: boolean };

const PATTERN = new RegExp(
	[
		// \b 對拉丁字有效;`not true` 中間的空白照樣比對得到。
		`\\b(?:${LATIN.map((w) => w.replace(/ /g, "\\s+")).join("|")})\\b`,
		CJK.join("|"),
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

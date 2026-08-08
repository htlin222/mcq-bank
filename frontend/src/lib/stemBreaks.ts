// 題幹裡從 PDF 帶進來的硬斷行。
//
// 官方考卷是排版過的 PDF,抽文字時每一行的結尾都變成 `\n`。於是題幹會長成:
//
//     (1)Of parenteral 1000µg cyanoCbl intramuscular or subcutaneous
//
//     injection, about 150µg will be retained from each injection
//
// 一句話被切在「subcutaneous / injection」中間 —— 那不是作者想分行,是紙張寬度
// 的痕跡(issue #91)。全題庫有 119 題、213 處。
//
// **這是渲染層的正規化,不是資料修正。** 兩個理由:
//
//   1. 一次改 119 題的題幹是不可逆的批次寫入,而判斷「這個換行該不該接」終究
//      是啟發式的 —— 猜錯就把題目改壞了,而且沒有原文可回頭比對(多數年份沒有
//      可比對的原始檔)。
//   2. 放在渲染層,判斷錯了只是那一題看起來怪,重新部署就回到原狀。
//
// 保留哪些換行是這裡唯一的判斷:**下一行是新的編號項目或選項標記就保留**
// (`(1)` `（1）` `1.` `(A)`),其餘接回去。句末標點結尾的換行也保留 —— 那是
// 作者真的想分段。

const ITEM_START = /^\s*(?:[（(]\s*\d+\s*[)）]|\d+\s*[.、]|[（(]\s*[A-Ea-e]\s*[)）])/;
// 句末:接下來那個換行是段落,不是折行。
const SENTENCE_END = /[.。!!??;;:：]\s*$/;
// 中日韓字元 —— 兩邊都是 CJK 時接回去不補空白。
const CJK = /[　-〿㐀-䶿一-鿿＀-￯]/;

/**
 * 把 PDF 折行接回去,保留真正的分行。純函式。
 *
 * @param stem 題幹原文(可能是 undefined —— 呼叫端有時還沒拿到資料)
 */
export function normalizeStemBreaks(stem: string): string {
	if (!stem) return "";
	// 先把連續空行壓成一個 —— PDF 抽出來常常一行之間夾兩三個空行,那些一律是
	// 排版痕跡。真正的分段靠下面的規則保留。
	const lines = stem.split(/\n+/);
	if (lines.length <= 1) return stem;

	let out = lines[0];
	for (let i = 1; i < lines.length; i++) {
		const line = lines[i];
		const keepBreak = ITEM_START.test(line) || SENTENCE_END.test(out);
		if (keepBreak) {
			out += `\n${line}`;
			continue;
		}
		const left = out.replace(/\s+$/, "");
		const right = line.replace(/^\s+/, "");
		// 中文之間不補空白;只要有一邊是英數就補一個,否則單字會黏在一起。
		const glue =
			CJK.test(left.slice(-1)) && CJK.test(right.slice(0, 1)) ? "" : " ";
		out = left + glue + right;
	}
	return out;
}

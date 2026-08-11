import { splitNegations } from "../lib/stemHighlight";

/**
 * 題幹,否定詞標紅加粗(#149)。
 *
 * 回報的原話是「這樣看題目比較好看」,但真正的價值是**不要整題讀完才發現問的是
 * 「何者錯誤」** —— 而那是這個題庫最常見的一種誤答。
 *
 * 用片段渲染而不是 `dangerouslySetInnerHTML`:題幹是匯入的資料,而這一層只是排版,
 * 沒有理由讓它有機會注入標記。切分邏輯(含詞表與為什麼是那幾個字)在
 * `lib/stemHighlight.ts`。
 *
 * **e-ink 底下顏色會被中和成黑色**(見 CLAUDE.md 的 1-bit 那節),所以語意不能
 * 只靠紅色:粗體本來就活得下來,再補一條底線 —— 同一節說的「顏色沒了之後,語意
 * 要換一個維度重講」。
 */
export function StemText({ text }: { text: string }) {
	const parts = splitNegations(text);
	// 沒有命中就不要多包一層 —— 絕大多數題目走這條。
	if (parts.length === 1 && !parts[0].hit) return <>{text}</>;

	return (
		<>
			{parts.map((p, i) =>
				p.hit ? (
					<strong
						// 片段沒有天然的 id,而這個陣列只由 text 決定、不會重排。
						// eslint-disable-next-line react/no-array-index-key
						key={i}
						className="font-bold text-rose-700 dark:text-rose-400 eink:underline"
					>
						{p.text}
					</strong>
				) : (
					// eslint-disable-next-line react/no-array-index-key
					<span key={i}>{p.text}</span>
				),
			)}
		</>
	);
}

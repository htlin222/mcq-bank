// 設定頁側欄導覽「目前在哪一區」的判定。抽成純函式才測得到 —— 元件那邊只剩
// 「量 getBoundingClientRect、丟進來、把結果畫出去」。

export type SectionTop = {
	id: string;
	/** 該區塊頂部距視窗頂的距離(getBoundingClientRect().top)。 */
	top: number;
};

export type SpyInput = {
	sections: SectionTop[];
	/** 判定線:頂部越過這條線的區塊就算「已進入」。對應 sticky header 高度。 */
	line: number;
	/** 是否已捲到頁面底部。 */
	atBottom: boolean;
};

/**
 * 回傳目前該高亮的區塊 id。
 *
 * 規則是「最後一個頂部已越過判定線的區塊」,而不是「與某個觀察帶相交的區塊」。
 * 差別在於超高的卡片:AI 助手展開提示詞編輯器後可能比整個視窗還高,那時它不與
 * 任何窄觀察帶相交,用相交判定會讓高亮憑空消失。
 *
 * 捲到底時強制選最後一區:最後一張卡片若比剩餘視窗矮,它的頂部永遠越不過判定
 * 線,不特判就永遠高亮不到。
 */
export function pickActiveSection(input: SpyInput): string | null {
	const { sections, line, atBottom } = input;
	if (sections.length === 0) return null;
	if (atBottom) return sections[sections.length - 1].id;

	// 不假設呼叫端給的順序就是版面順序 —— 依 top 排序後再找。
	const ordered = [...sections].sort((a, b) => a.top - b.top);
	let current = ordered[0].id;
	for (const s of ordered) {
		if (s.top <= line) current = s.id;
	}
	return current;
}

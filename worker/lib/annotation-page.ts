// 畫記寫進 lecture_annotations.pdf_page 的頁碼。1-based,跟講義筆記與書籤
// 同一套。0 是舊的 viewer index,收進來會讓清單上的「p.1」其實停在第 2 頁。

/** 整數且 >= 1 才是 PDF 頁碼。其他(含 0)回 null,呼叫端回 400。 */
export function annotationPdfPage(value: unknown): number | null {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 1) return null;
	return value;
}

import { useMemo } from "react";
import { renderStaticDoc } from "../lib/staticDoc";

/**
 * `ReadOnlyContent` 的無編輯器版本 —— 同樣的畫面,但不建 ProseMirror。
 *
 * 用在**不需要畫記 / 自動挖空 / 防劇透**的唯讀內容上(留言、挑戰理由、Anki 卡)。
 * 詳解與個人筆記仍然走 `AnnotatableContent`:那兩層要的是 decoration 與 mark,
 * 沒有 EditorView 做不到。
 *
 * 外層刻意重用 `.tiptap` 與 `contenteditable="false"`,不另開一套 class ——
 * styles.css 裡整段排版(標題級距、清單縮排、表格、mention/qref 配色、e-ink 的
 * 中和層)都掛在這兩個選擇器上。換一個名字等於要把那些規則抄第二份,而抄出來
 * 的第二份會慢慢跟第一份走散。
 *
 * `contenteditable="false"` 同時是 `useTextSelection` 的判準之一:它讓
 * `isContentEditable` 為 false,所以選字工具列照常出現(而在真的編輯器裡不會)。
 */
export function StaticContent({ content }: { content: any }) {
	const nodes = useMemo(() => renderStaticDoc(content), [content]);
	return (
		<div
			className="tiptap"
			contentEditable={false}
			suppressContentEditableWarning
		>
			{nodes}
		</div>
	);
}

import { useCallback, useEffect, useState } from "react";

export type TextSelection = {
	text: string;
	// Anchoring rect of the selection range, in client (viewport) coords.
	rect: DOMRect;
	// 同一段選取的 Range 拷貝。`rect` 只是快照,捲動後就過期;工具列靠這個
	// 重新量測,才能跟著選取一起移動(見 SelectionToolbar 的 measure)。
	// 拷貝而非原件:使用者點工具列會 collapse 掉 window 的 Selection。
	range: Range;
	// 選取的共同祖先節點。工具列用它反查選取落在哪個 AnnotatableContent 裡
	// (決定要不要亮「螢光標記」),以及往上找最近的區塊當作 AI 的 {{context}}。
	node: Node | null;
	// 選取兩端。畫記需要把它們換算成 ProseMirror 位置。
	anchorNode: Node | null;
	anchorOffset: number;
	focusNode: Node | null;
	focusOffset: number;
};

// Walk up from a node to decide whether the selection lives inside an editable
// surface (input / textarea / contenteditable — e.g. the TipTap editor). We
// never want the toolbar popping up while the user is typing.
function isInEditable(node: Node | null): boolean {
	let el: Element | null =
		node instanceof Element ? node : (node?.parentElement ?? null);
	while (el) {
		const tag = el.tagName;
		if (tag === "INPUT" || tag === "TEXTAREA") return true;
		if ((el as HTMLElement).isContentEditable) return true;
		el = el.parentElement;
	}
	return false;
}

// 一個字就夠 —— 中文兩字詞(貧血、溶血)是畫記的日常。更嚴的門檻由各動作
// 自己把關(見 lib/selectionActions.ts:「查參考資料」仍要求 ≥3 字且含實詞)。
const MIN_LEN = 1;
const MAX_LEN = 400;

// 只擋掉完全沒有字詞內容的選取(純標點、純空白、純符號)—— 那種選取三個動作
// 沒有一個做得了事,彈出工具列只是噪音。數字算字詞:選到「1p36」是合理的。
function hasWordChar(text: string): boolean {
	return /[\p{L}\p{N}]/u.test(text);
}

/**
 * App-wide text-selection watcher for the unified selection toolbar.
 *
 * Produces a *snapshot* (text + anchor rect + the nodes involved) only when a
 * selection settles on mouseup / touchend and passes the guardrails (length
 * 1–400, has a word character, not inside an editable field). The snapshot is
 * deliberately independent of the live DOM Selection afterwards: clicking the
 * toolbar collapses the window selection, but the toolbar keeps rendering from
 * the snapshot. Dismissal is the caller's job via `clear()` (Esc /
 * outside-click / navigation) — see SelectionToolbar.
 *
 * A plain click that selects nothing collapses to null here, which the toolbar
 * uses as implicit outside-click-to-dismiss.
 */
export function useTextSelection(): {
	selection: TextSelection | null;
	clear: () => void;
} {
	const [selection, setSelection] = useState<TextSelection | null>(null);
	const clear = useCallback(() => setSelection(null), []);

	useEffect(() => {
		let raf = 0;

		function evaluate() {
			const sel = window.getSelection();
			if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
				setSelection(null);
				return;
			}
			const text = sel.toString().replace(/\s+/g, " ").trim();
			if (text.length < MIN_LEN || text.length > MAX_LEN) {
				setSelection(null);
				return;
			}
			if (!hasWordChar(text)) {
				setSelection(null);
				return;
			}
			const range = sel.getRangeAt(0);
			if (
				isInEditable(range.commonAncestorContainer) ||
				isInEditable(sel.anchorNode)
			) {
				setSelection(null);
				return;
			}
			const rect = range.getBoundingClientRect();
			if (rect.width === 0 && rect.height === 0) {
				setSelection(null);
				return;
			}
			setSelection({
				text,
				rect,
				range: range.cloneRange(),
				node: range.commonAncestorContainer,
				anchorNode: sel.anchorNode,
				anchorOffset: sel.anchorOffset,
				focusNode: sel.focusNode,
				focusOffset: sel.focusOffset,
			});
		}

		function onSettle(e: Event) {
			// Selections that end inside the toolbar itself must not re-trigger /
			// clear it (clicking a result would otherwise collapse the toolbar).
			const target = e.target as Element | null;
			if (target && target.closest("[data-selection-toolbar]")) return;
			cancelAnimationFrame(raf);
			// rAF so window.getSelection() reflects the finished selection.
			raf = requestAnimationFrame(evaluate);
		}

		document.addEventListener("mouseup", onSettle);
		document.addEventListener("touchend", onSettle);
		return () => {
			cancelAnimationFrame(raf);
			document.removeEventListener("mouseup", onSettle);
			document.removeEventListener("touchend", onSettle);
		};
	}, []);

	return { selection, clear };
}

import { useCallback, useEffect, useState } from "react";

export type TextSelection = {
	text: string;
	// Anchoring rect of the selection range, in client (viewport) coords.
	rect: DOMRect;
};

// Walk up from a node to decide whether the selection lives inside an editable
// surface (input / textarea / contenteditable — e.g. the TipTap editor). We
// never want the "問 Wintrobe" badge popping up while the user is typing.
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

const MIN_LEN = 3;
const MAX_LEN = 400;

// Only offer a lookup for selections with real lexical content. This suppresses
// the badge on accidental / nonsense selections — pure punctuation ("…"),
// numbers ("2023"), symbols, or stray whitespace — which would only ever come
// back empty. (Such queries are already error-safe server-side: each token is a
// quoted FTS phrase, so they match nothing rather than erroring. This is purely
// to avoid a pointless badge.) A term needs ≥2 Latin letters (AML, CD20, …) or
// ≥1 CJK character (白血病) to qualify.
function hasMeaningfulContent(text: string): boolean {
	const latin = text.match(/[a-zA-Z]/g)?.length ?? 0;
	const cjk = text.match(/[㐀-鿿豈-﫿]/g)?.length ?? 0;
	return latin >= 2 || cjk >= 1;
}

/**
 * App-wide text-selection watcher for the textbook-lookup popup.
 *
 * Produces a *snapshot* (text + anchor rect) only when a selection settles on
 * mouseup / touchend and passes the guardrails (length 3–400, not inside an
 * editable field). The snapshot is deliberately independent of the live DOM
 * Selection afterwards: clicking the popup collapses the window selection, but
 * the popup keeps rendering from the snapshot. Dismissal is the caller's job
 * via `clear()` (Esc / outside-click / navigation) — see TextbookLookupPopup.
 *
 * A plain click that selects nothing collapses to null here, which the popup
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
			if (!hasMeaningfulContent(text)) {
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
			setSelection({ text, rect });
		}

		function onSettle(e: Event) {
			// Selections that end inside the popup itself must not re-trigger /
			// clear it (clicking a result would otherwise collapse the badge).
			const target = e.target as Element | null;
			if (target && target.closest("[data-textbook-popup]")) return;
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

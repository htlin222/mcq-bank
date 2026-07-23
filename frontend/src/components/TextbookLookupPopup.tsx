import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import { BookOpen, Loader2 } from "lucide-react";
import {
	useTextSelection,
	type TextSelection,
} from "../lib/useTextSelection";
import { lookupTextbook, type TextbookHit } from "../lib/textbookApi";
import { HighlightedSnippet } from "./lecture/HighlightedSnippet";

const POPUP_W = 320;

// App-wide mount point (see App.tsx). Watches text selections everywhere and
// offers「📖 Wintrobe 怎麼說?」. `key` remounts the popup fresh for each new
// selection so the badge always starts collapsed.
export function TextbookSelectionListener() {
	const { selection, clear } = useTextSelection();
	if (!selection) return null;
	return (
		<TextbookLookupPopup
			key={`${selection.rect.top}:${selection.text.slice(0, 24)}`}
			selection={selection}
			onDismiss={clear}
		/>
	);
}

// Strip the redundant "Wintrobe " prefix from the stored title for compact
// display (title is "Wintrobe Ch92 · Chronic Lymphocytic Leukemia").
function chapterLabel(title: string): string {
	return title.replace(/^Wintrobe\s+/, "");
}

function TextbookLookupPopup({
	selection,
	onDismiss,
}: {
	selection: TextSelection;
	onDismiss: () => void;
}) {
	const [expanded, setExpanded] = useState(false);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState(false);
	const [hits, setHits] = useState<TextbookHit[] | null>(null);
	const rootRef = useRef<HTMLDivElement>(null);

	// Dismiss on Esc, on scroll/resize (the anchor rect goes stale), and on
	// outside pointerdown. The outside handler is armed on the next tick so the
	// pointer-up that created the selection doesn't instantly close the badge.
	useEffect(() => {
		function onKey(e: KeyboardEvent) {
			if (e.key === "Escape") onDismiss();
		}
		function onScroll() {
			onDismiss();
		}
		function onDown(e: MouseEvent) {
			if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
				onDismiss();
			}
		}
		document.addEventListener("keydown", onKey);
		window.addEventListener("scroll", onScroll, true);
		window.addEventListener("resize", onScroll);
		const t = window.setTimeout(
			() => document.addEventListener("mousedown", onDown),
			0,
		);
		return () => {
			window.clearTimeout(t);
			document.removeEventListener("keydown", onKey);
			window.removeEventListener("scroll", onScroll, true);
			window.removeEventListener("resize", onScroll);
			document.removeEventListener("mousedown", onDown);
		};
	}, [onDismiss]);

	async function runLookup() {
		setExpanded(true);
		setLoading(true);
		setError(false);
		try {
			const { hits } = await lookupTextbook(selection.text, 5);
			setHits(hits);
		} catch {
			setError(true);
		} finally {
			setLoading(false);
		}
	}

	// Position: fixed, biased below the selection; flips above when there isn't
	// room. Horizontally clamped to the viewport.
	const rect = selection.rect;
	const left = Math.min(
		Math.max(8, rect.left),
		Math.max(8, window.innerWidth - POPUP_W - 8),
	);
	const openUp =
		expanded && rect.bottom + 280 > window.innerHeight && rect.top > 300;
	const style: React.CSSProperties = {
		position: "fixed",
		left,
		zIndex: 60,
		...(expanded ? { width: POPUP_W } : {}),
		...(openUp
			? { bottom: window.innerHeight - rect.top + 8 }
			: { top: rect.bottom + 8 }),
	};

	const top = hits && hits.length > 0 ? hits[0] : null;

	return createPortal(
		<div
			ref={rootRef}
			data-textbook-popup
			style={style}
			onMouseDown={(e) => e.stopPropagation()}
		>
			{!expanded ? (
				<button
					type="button"
					onClick={runLookup}
					className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-ink-900 text-white dark:bg-ink-100 dark:text-ink-900 text-sm font-medium shadow-lg hover:opacity-90 transition whitespace-nowrap"
				>
					<BookOpen size={14} />
					Wintrobe 怎麼說?
				</button>
			) : (
				<div className="rounded-xl border border-ink-200 dark:border-ink-700 bg-white dark:bg-ink-800 shadow-xl overflow-hidden">
					<div className="flex items-center gap-1.5 px-3 py-2 border-b border-ink-100 dark:border-ink-700 text-xs font-medium text-ink-500 dark:text-ink-400">
						<BookOpen size={13} />
						Wintrobe’s Clinical Hematology
					</div>

					{loading && (
						<div className="flex items-center gap-2 px-3 py-4 text-sm text-ink-500">
							<Loader2 size={15} className="animate-spin" />
							搜尋教科書…
						</div>
					)}

					{!loading && error && (
						<div className="px-3 py-4 text-sm text-red-600 dark:text-red-400">
							查詢失敗,請稍後再試。
						</div>
					)}

					{!loading && !error && hits && hits.length === 0 && (
						<div className="px-3 py-4 text-sm text-ink-500 dark:text-ink-400">
							教科書中找不到相關段落。
						</div>
					)}

					{!loading && !error && top && hits && (
						<div className="px-3 py-2.5">
							{/* Layer 1 — snippet glance, zero navigation / zero PDF load */}
							<div className="text-[13px] leading-relaxed text-ink-800 dark:text-ink-200">
								<HighlightedSnippet text={top.snippet} />
							</div>

							{/* Layer 3 — real <a> deep-links (Cmd/Ctrl-click = new tab) */}
							<div className="mt-2.5 pt-2 border-t border-ink-100 dark:border-ink-700 space-y-1">
								{hits.slice(0, 3).map((h) => (
									<Link
										key={`${h.slug}:${h.page}`}
										to={`/lectures/${h.slug}?page=${h.page}`}
										onClick={(e) => {
											if (!e.metaKey && !e.ctrlKey) onDismiss();
										}}
										className="flex items-center justify-between gap-2 px-1.5 py-1 rounded text-xs text-ink-600 dark:text-ink-300 hover:bg-ink-50 dark:hover:bg-ink-700/60 transition"
									>
										<span className="truncate">{chapterLabel(h.title)}</span>
										<span className="shrink-0 tabular-nums text-ink-400">
											p.{h.page}
										</span>
									</Link>
								))}
							</div>
						</div>
					)}
				</div>
			)}
		</div>,
		document.body,
	);
}

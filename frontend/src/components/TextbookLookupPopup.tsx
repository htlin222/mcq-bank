import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import { BookOpen, GraduationCap, Loader2, Sparkles } from "lucide-react";
import {
	useTextSelection,
	type TextSelection,
} from "../lib/useTextSelection";
import {
	lookupReference,
	type ReferenceHit,
	type ReferenceResult,
} from "../lib/textbookApi";
import { HighlightedSnippet } from "./lecture/HighlightedSnippet";

const POPUP_W = 340;

// App-wide mount point (see App.tsx). Watches text selections everywhere and
// offers「📖 查參考資料」— the top Wintrobe textbook page AND the top 複習講義
// slides for the selection. `key` remounts the popup fresh for each new
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

// "Wintrobe Ch92 · Chronic Lymphocytic Leukemia" → "Ch92 · Chronic …"
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
	const [result, setResult] = useState<ReferenceResult | null>(null);
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
			const r = await lookupReference(selection.text, 5);
			setResult(r);
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
		expanded && rect.bottom + 300 > window.innerHeight && rect.top > 320;
	const style: React.CSSProperties = {
		position: "fixed",
		left,
		zIndex: 60,
		...(expanded ? { width: POPUP_W } : {}),
		...(openUp
			? { bottom: window.innerHeight - rect.top + 8 }
			: { top: rect.bottom + 8 }),
	};

	const empty =
		result && result.textbook.length === 0 && result.lecture.length === 0;

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
					查參考資料
				</button>
			) : (
				<div className="rounded-xl border border-ink-200 dark:border-ink-700 bg-white dark:bg-ink-800 shadow-xl overflow-hidden max-h-[70vh] overflow-y-auto">
					{loading && (
						<div className="flex items-center gap-2 px-3 py-4 text-sm text-ink-500">
							<Loader2 size={15} className="animate-spin" />
							搜尋教科書與講義…
						</div>
					)}

					{!loading && error && (
						<div className="px-3 py-4 text-sm text-red-600 dark:text-red-400">
							查詢失敗,請稍後再試。
						</div>
					)}

					{!loading && !error && empty && (
						<div className="px-3 py-4 text-sm text-ink-500 dark:text-ink-400">
							教科書與講義中找不到相關段落。
						</div>
					)}

					{!loading && !error && result && !empty && (
						<div className="divide-y divide-ink-100 dark:divide-ink-700">
							{result.refined && (
								<div className="flex items-center gap-1 px-3 py-1.5 text-[11px] text-ink-400 dark:text-ink-500">
									<Sparkles size={11} />
									已用 AI 精煉查詢
								</div>
							)}
							{result.textbook.length > 0 && (
								<ReferenceGroup
									icon={<BookOpen size={13} />}
									label="Wintrobe 教科書"
									hits={result.textbook}
									labelOf={(h) => chapterLabel(h.title)}
									onNavigate={onDismiss}
								/>
							)}
							{result.lecture.length > 0 && (
								<ReferenceGroup
									icon={<GraduationCap size={13} />}
									label="複習班講義"
									hits={result.lecture}
									labelOf={(h) => h.title}
									onNavigate={onDismiss}
								/>
							)}
						</div>
					)}
				</div>
			)}
		</div>,
		document.body,
	);
}

function ReferenceGroup({
	icon,
	label,
	hits,
	labelOf,
	onNavigate,
}: {
	icon: React.ReactNode;
	label: string;
	hits: ReferenceHit[];
	labelOf: (h: ReferenceHit) => string;
	onNavigate: () => void;
}) {
	const top = hits[0];
	return (
		<div className="px-3 py-2.5">
			<div className="flex items-center gap-1.5 mb-1.5 text-xs font-medium text-ink-500 dark:text-ink-400">
				{icon}
				{label}
			</div>

			{/* Layer 1 — snippet glance of the top hit, zero navigation / zero load */}
			<div className="text-[13px] leading-relaxed text-ink-800 dark:text-ink-200">
				<HighlightedSnippet text={top.snippet} />
			</div>

			{/* Layer 3 — real <a> deep-links (Cmd/Ctrl-click = new tab) */}
			<div className="mt-2 space-y-0.5">
				{hits.slice(0, 3).map((h) => (
					<Link
						key={`${h.slug}:${h.page}`}
						to={`/lectures/${h.slug}?page=${h.page}`}
						onClick={(e) => {
							if (!e.metaKey && !e.ctrlKey) onNavigate();
						}}
						className="flex items-center justify-between gap-2 px-1.5 py-1 rounded text-xs text-ink-600 dark:text-ink-300 hover:bg-ink-50 dark:hover:bg-ink-700/60 transition"
					>
						<span className="truncate">{labelOf(h)}</span>
						<span className="shrink-0 tabular-nums text-ink-400">
							p.{h.page}
						</span>
					</Link>
				))}
			</div>
		</div>
	);
}

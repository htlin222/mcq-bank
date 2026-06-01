// In-reader search box. Anchored in the lecture-reader title bar; lets the
// reader search the CURRENT lecture's PDF text or the user's own notes for
// it, then jump to a matching page without leaving the reader.
//
// Backed by the same /api/lectures/search endpoint as the list-page search
// — the `slug` query param scopes results to the open lecture.

import { useEffect, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import {
	searchLectures,
	type LectureSearchHit,
	type LectureSearchScope,
} from "../../lib/lectureApi";
import { HighlightedSnippet } from "./HighlightedSnippet";

const DEBOUNCE_MS = 250;
const RESULT_LIMIT = 30;

export interface LectureSearchBoxProps {
	/** Slug of the currently-open lecture. Search is restricted to this slug. */
	slug: string;
	/** Called with a 0-indexed page number when the user picks a result. */
	onJumpToPage: (zeroIndexedPage: number) => void;
}

export function LectureSearchBox({ slug, onJumpToPage }: LectureSearchBoxProps) {
	const [query, setQuery] = useState("");
	const [scope, setScope] = useState<LectureSearchScope>("pdf");
	const [results, setResults] = useState<LectureSearchHit[] | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [open, setOpen] = useState(false);
	const rootRef = useRef<HTMLDivElement>(null);

	const trimmed = query.trim();
	const active = trimmed.length > 0;

	// Reset search state whenever the open lecture changes.
	useEffect(() => {
		setQuery("");
		setResults(null);
		setError(null);
		setOpen(false);
	}, [slug]);

	// Debounced search. Race-safe: if the query / scope / slug changes while a
	// fetch is in flight, the result of the older fetch is discarded.
	useEffect(() => {
		if (!active) {
			setResults(null);
			setLoading(false);
			setError(null);
			return;
		}
		setLoading(true);
		setError(null);
		setOpen(true);
		let alive = true;
		const t = window.setTimeout(async () => {
			try {
				const r = await searchLectures(trimmed, scope, RESULT_LIMIT, slug);
				if (alive) setResults(r.results);
			} catch (e: any) {
				if (alive) {
					setResults([]);
					setError(e?.message || "搜尋失敗");
				}
			} finally {
				if (alive) setLoading(false);
			}
		}, DEBOUNCE_MS);
		return () => {
			alive = false;
			window.clearTimeout(t);
		};
	}, [trimmed, scope, slug, active]);

	// Click outside / Escape to close the popover without clearing the query
	// — closes the dropdown; the input keeps its text so the user can re-open
	// by focusing the field.
	useEffect(() => {
		if (!open) return;
		function onMouseDown(e: MouseEvent) {
			const root = rootRef.current;
			if (root && !root.contains(e.target as Node)) setOpen(false);
		}
		function onKey(e: KeyboardEvent) {
			if (e.key === "Escape") setOpen(false);
		}
		document.addEventListener("mousedown", onMouseDown);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("mousedown", onMouseDown);
			document.removeEventListener("keydown", onKey);
		};
	}, [open]);

	function pick(hit: LectureSearchHit) {
		// hit.page is 1-indexed from the server (matches PDF page numbers); the
		// viewer's scrollToPage / goToPage take 0-indexed input.
		const target = Math.max(0, hit.page - 1);
		onJumpToPage(target);
		setOpen(false);
	}

	function clear() {
		setQuery("");
		setResults(null);
		setError(null);
		setOpen(false);
	}

	return (
		<div ref={rootRef} className="relative flex-1 min-w-0 max-w-xl">
			<div className="flex items-stretch gap-1">
				<div className="relative flex-1 min-w-0">
					<Search
						size={14}
						className={
							"absolute left-2.5 top-1/2 -translate-y-1/2 " +
							(loading
								? "text-accent animate-pulse"
								: "text-ink-400 dark:text-ink-500")
						}
						aria-hidden="true"
					/>
					<input
						type="search"
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						onFocus={() => active && setOpen(true)}
						placeholder={
							scope === "pdf"
								? "搜尋此份講義 PDF 內文…"
								: "搜尋此份講義的筆記…"
						}
						aria-label="搜尋此份講義"
						className="w-full border border-ink-200 dark:border-ink-700 dark:bg-ink-800 rounded pl-7 pr-7 py-1 text-sm focus:outline-none focus:border-accent text-ink-900 dark:text-ink-100 placeholder:text-ink-400 dark:placeholder:text-ink-500"
					/>
					{query && (
						<button
							type="button"
							onClick={clear}
							aria-label="清除搜尋"
							className="absolute right-1.5 top-1/2 -translate-y-1/2 text-ink-400 hover:text-ink-700 dark:text-ink-500 dark:hover:text-ink-200"
						>
							<X size={14} />
						</button>
					)}
				</div>
				<div
					className="inline-flex rounded border border-ink-200 dark:border-ink-700 overflow-hidden shrink-0"
					role="group"
					aria-label="搜尋範圍"
				>
					<ScopeButton
						active={scope === "pdf"}
						onClick={() => setScope("pdf")}
						label="PDF"
					/>
					<ScopeButton
						active={scope === "notes"}
						onClick={() => setScope("notes")}
						label="筆記"
					/>
				</div>
			</div>

			{open && active && (
				<div
					className="absolute left-0 right-0 top-full mt-1 z-30 max-h-[60vh] overflow-y-auto bg-white dark:bg-ink-800 border border-ink-200 dark:border-ink-700 rounded shadow-lg"
					role="listbox"
				>
					{loading && results === null ? (
						<div className="px-3 py-2 text-sm text-ink-400 dark:text-ink-500">
							搜尋中…
						</div>
					) : error ? (
						<div className="px-3 py-2 text-sm text-rose-600 dark:text-rose-400">
							搜尋失敗:{error}
						</div>
					) : !results || results.length === 0 ? (
						<div className="px-3 py-2 text-sm text-ink-400 dark:text-ink-500">
							沒有找到符合的內容。
						</div>
					) : (
						<ul>
							{results.map((r, i) => (
								<li key={`${r.slug}-${r.page}-${i}`}>
									<button
										type="button"
										onClick={() => pick(r)}
										role="option"
										className="w-full text-left px-3 py-2 hover:bg-ink-50 dark:hover:bg-ink-700 border-b border-ink-100 dark:border-ink-700 last:border-b-0"
									>
										<div className="flex items-baseline gap-2">
											<span className="font-mono text-xs text-ink-500 dark:text-ink-400 shrink-0">
												p.{r.page}
											</span>
											<span className="text-sm leading-relaxed text-ink-700 dark:text-ink-200">
												<HighlightedSnippet text={r.snippet} />
											</span>
										</div>
									</button>
								</li>
							))}
						</ul>
					)}
				</div>
			)}
		</div>
	);
}

function ScopeButton({
	active,
	onClick,
	label,
}: {
	active: boolean;
	onClick: () => void;
	label: string;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			aria-pressed={active}
			className={
				"px-2 py-1 text-xs transition " +
				(active
					? "bg-accent text-white"
					: "bg-white dark:bg-ink-800 text-ink-700 dark:text-ink-200 hover:bg-ink-50 dark:hover:bg-ink-700")
			}
		>
			{label}
		</button>
	);
}

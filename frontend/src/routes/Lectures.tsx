import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Highlighter, NotebookPen, Search } from "lucide-react";
import {
	listLectures,
	searchLectures,
	type LectureDoc,
	type LectureSearchHit,
	type LectureSearchScope,
} from "../lib/lectureApi";
import { HighlightedSnippet } from "../components/lecture/HighlightedSnippet";
import { TextbookToc } from "../components/lecture/TextbookToc";
import {
	LectureCardSkeletonGrid,
	LectureSearchResultSkeleton,
} from "../components/Skeleton";

// Wait this long after the last keystroke before firing the search request.
const SEARCH_DEBOUNCE_MS = 250;

// Which registry the grid is showing: 複習班講義 vs. the Wintrobe textbook.
type LectureView = "lecture" | "textbook";

export default function Lectures() {
	const [view, setView] = useState<LectureView>("lecture");
	const [docs, setDocs] = useState<LectureDoc[] | null>(null);
	const [error, setError] = useState<string | null>(null);

	// Search state
	const [query, setQuery] = useState("");
	const [scope, setScope] = useState<LectureSearchScope>("pdf");
	const [results, setResults] = useState<LectureSearchHit[] | null>(null);
	const [searching, setSearching] = useState(false);
	const [searchError, setSearchError] = useState<string | null>(null);

	const trimmed = query.trim();
	const searchMode = trimmed.length > 0;

	// Registry load — refetches when the view tab changes. Reset docs to null
	// first so the skeleton shows instead of the previous tab's cards.
	useEffect(() => {
		let alive = true;
		setDocs(null);
		setError(null);
		listLectures(view)
			.then((d) => {
				if (alive) setDocs(d);
			})
			.catch((e) => {
				if (alive) setError(e?.message || "載入失敗");
			});
		return () => {
			alive = false;
		};
	}, [view]);

	// Debounced search. The cleanup races a stale request: if the query
	// changes while a fetch is in flight, we ignore its result.
	useEffect(() => {
		if (!searchMode) {
			setResults(null);
			setSearching(false);
			setSearchError(null);
			return;
		}
		setSearching(true);
		setSearchError(null);
		let alive = true;
		const t = window.setTimeout(async () => {
			try {
				const r = await searchLectures(trimmed, scope, 30);
				if (alive) setResults(r.results);
			} catch (e: any) {
				if (alive) {
					setResults([]);
					setSearchError(e?.message || "搜尋失敗");
				}
			} finally {
				if (alive) setSearching(false);
			}
		}, SEARCH_DEBOUNCE_MS);
		return () => {
			alive = false;
			window.clearTimeout(t);
		};
	}, [trimmed, scope, searchMode]);

	return (
		<div className="max-w-5xl lg:max-w-6xl xl:max-w-7xl mx-auto px-4 sm:px-6 py-8">
			<div className="mb-6 flex flex-wrap items-center gap-x-4 gap-y-3">
				<h1 className="font-serif text-3xl text-ink-900 dark:text-ink-100">
					{view === "textbook" ? "Wintrobe 教科書" : "複習班講義"}
				</h1>
				<ViewTabs view={view} onView={setView} />
			</div>

			<SearchBar
				query={query}
				onQuery={setQuery}
				scope={scope}
				onScope={setScope}
				busy={searching}
			/>

			{searchMode ? (
				<SearchResults
					results={results}
					loading={searching}
					error={searchError}
				/>
			) : error ? (
				<p className="text-rose-600 dark:text-rose-400 text-sm">
					無法載入{view === "textbook" ? "教科書" : "講義"}:{error}
				</p>
			) : docs === null ? (
				<LectureCardSkeletonGrid count={6} />
			) : docs.length === 0 ? (
				<p className="text-ink-400 dark:text-ink-500 text-sm">
					{view === "textbook"
						? "目前還沒有匯入教科書章節。"
						: "目前還沒有任何講義。"}
				</p>
			) : view === "textbook" ? (
				<TextbookToc docs={docs} />
			) : (
				<div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
					{docs.map((d) => (
						<LectureCard key={d.slug} doc={d} />
					))}
				</div>
			)}
		</div>
	);
}

// ── View tabs (講義 / 教科書) ──────────────────────────────────────────

function ViewTabs({
	view,
	onView,
}: {
	view: "lecture" | "textbook";
	onView: (v: "lecture" | "textbook") => void;
}) {
	return (
		<div
			className="inline-flex rounded border border-ink-200 dark:border-ink-700 overflow-hidden"
			role="tablist"
			aria-label="講義類別"
		>
			<ViewTab
				active={view === "lecture"}
				onClick={() => onView("lecture")}
				label="複習班講義"
			/>
			<ViewTab
				active={view === "textbook"}
				onClick={() => onView("textbook")}
				label="Wintrobe 教科書"
			/>
		</div>
	);
}

function ViewTab({
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
			role="tab"
			onClick={onClick}
			aria-selected={active}
			className={
				"px-3 py-1.5 text-sm transition " +
				(active
					? "bg-accent text-white"
					: "bg-white dark:bg-ink-800 text-ink-700 dark:text-ink-200 hover:bg-ink-50 dark:hover:bg-ink-700")
			}
		>
			{label}
		</button>
	);
}

// ── Search bar + scope toggle ─────────────────────────────────────────

function SearchBar({
	query,
	onQuery,
	scope,
	onScope,
	busy,
}: {
	query: string;
	onQuery: (q: string) => void;
	scope: LectureSearchScope;
	onScope: (s: LectureSearchScope) => void;
	busy: boolean;
}) {
	return (
		<div className="mb-6 flex flex-col sm:flex-row gap-3">
			<div className="relative flex-1">
				<Search
					size={16}
					className={
						"absolute left-3 top-1/2 -translate-y-1/2 " +
						(busy
							? "text-accent animate-pulse"
							: "text-ink-400 dark:text-ink-500")
					}
					aria-hidden="true"
				/>
				<input
					type="search"
					value={query}
					onChange={(e) => onQuery(e.target.value)}
					placeholder={
						scope === "pdf"
							? "搜尋講義 PDF 內文…"
							: "搜尋你的筆記內容…"
					}
					aria-label="搜尋講義"
					className="w-full border border-ink-200 dark:border-ink-700 dark:bg-ink-800 rounded pl-9 pr-4 py-2 focus:outline-none focus:border-accent text-ink-900 dark:text-ink-100 placeholder:text-ink-400 dark:placeholder:text-ink-500"
				/>
			</div>
			<div
				className="inline-flex rounded border border-ink-200 dark:border-ink-700 overflow-hidden self-start sm:self-auto"
				role="group"
				aria-label="搜尋範圍"
			>
				<ScopeButton
					active={scope === "pdf"}
					onClick={() => onScope("pdf")}
					label="PDF 內文"
				/>
				<ScopeButton
					active={scope === "notes"}
					onClick={() => onScope("notes")}
					label="筆記"
				/>
			</div>
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
				"px-3 py-2 text-sm transition " +
				(active
					? "bg-accent text-white"
					: "bg-white dark:bg-ink-800 text-ink-700 dark:text-ink-200 hover:bg-ink-50 dark:hover:bg-ink-700")
			}
		>
			{label}
		</button>
	);
}

// ── Search results ────────────────────────────────────────────────────

function SearchResults({
	results,
	loading,
	error,
}: {
	results: LectureSearchHit[] | null;
	loading: boolean;
	error: string | null;
}) {
	if (results === null && loading) {
		return <LectureSearchResultSkeleton count={4} />;
	}
	if (error) {
		return (
			<p className="text-rose-600 dark:text-rose-400 text-sm">
				搜尋失敗:{error}
			</p>
		);
	}
	if (!results || results.length === 0) {
		return (
			<p className="text-ink-400 dark:text-ink-500 text-sm">
				沒有找到符合的內容。
			</p>
		);
	}
	return (
		<ul className="space-y-2">
			{results.map((r, i) => (
				<li key={`${r.slug}-${r.page}-${i}`}>
					<Link
						to={`/lectures/${r.slug}?page=${r.page}`}
						className="block bg-white dark:bg-ink-800 border border-ink-200 dark:border-ink-700 rounded p-3 hover:border-accent hover:shadow-paper transition"
					>
						<div className="flex items-baseline gap-3 mb-1">
							<span className="font-serif text-ink-900 dark:text-ink-100">
								{r.title}
							</span>
							{r.instructor && (
								<span className="text-xs text-ink-500 dark:text-ink-400">
									{r.instructor}
								</span>
							)}
							<span className="ml-auto text-xs font-mono text-ink-500 dark:text-ink-400 shrink-0">
								p.{r.page}
							</span>
						</div>
						<p className="text-sm leading-relaxed text-ink-700 dark:text-ink-200">
							<HighlightedSnippet text={r.snippet} />
						</p>
					</Link>
				</li>
			))}
		</ul>
	);
}

// ── Existing card (unchanged) ─────────────────────────────────────────

function LectureCard({ doc }: { doc: LectureDoc }) {
	return (
		<Link
			to={`/lectures/${doc.slug}`}
			className="group flex flex-col bg-white dark:bg-ink-800 border border-ink-200 dark:border-ink-700 rounded-lg p-4 hover:border-accent transition"
		>
			<h2 className="font-serif text-lg leading-snug text-ink-900 dark:text-ink-100 group-hover:text-accent transition">
				{doc.title}
			</h2>
			{doc.instructor && (
				<p className="mt-1 text-sm text-ink-500 dark:text-ink-400">
					{doc.instructor}
				</p>
			)}
			<div className="mt-auto pt-4 flex items-center gap-2 text-xs text-ink-400 dark:text-ink-500">
				<span>{doc.page_count} 頁</span>
				{doc.anno_count > 0 && (
					<span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300">
						<Highlighter size={12} />
						{doc.anno_count}
					</span>
				)}
				{doc.note_count > 0 && (
					<span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-accent/10 text-accent">
						<NotebookPen size={12} />
						{doc.note_count}
					</span>
				)}
			</div>
		</Link>
	);
}

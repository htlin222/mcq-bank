import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ChevronRight, Highlighter, NotebookPen, Search } from "lucide-react";
import {
	listLectures,
	listTextbookChapters,
	searchLectures,
	type LectureDoc,
	type LectureSearchHit,
	type LectureSearchScope,
	type TextbookChapter,
} from "../lib/lectureApi";
import { HighlightedSnippet } from "../components/lecture/HighlightedSnippet";
import {
	LectureCardSkeletonGrid,
	LectureSearchResultSkeleton,
} from "../components/Skeleton";

// Wait this long after the last keystroke before firing the search request.
const SEARCH_DEBOUNCE_MS = 250;

type LectureTab = "lectures" | "textbook";

// Wintrobe's Clinical Hematology 15e — Part 分組。lecture_docs 沒有 Part 欄位,
// 章節是平的 (sort_order = 章號),所以在此依主題邊界把 108 章歸入 8 個 Part。
// [from, to] 皆含,對應 chapter.sort_order。改版換書時同步更新這張表。
const WINTROBE_PARTS: {
	part: string;
	title: string;
	from: number;
	to: number;
}[] = [
	{ part: "I", title: "Laboratory Hematology", from: 1, to: 4 },
	{ part: "II", title: "The Normal Hematologic System", from: 5, to: 21 },
	{ part: "III", title: "Transfusion Medicine", from: 22, to: 23 },
	{ part: "IV", title: "Disorders of Red Cells", from: 24, to: 45 },
	{ part: "V", title: "Hemostasis and Thrombosis", from: 46, to: 56 },
	{
		part: "VI",
		title: "Nonmalignant Disorders of Leukocytes, Spleen & Immune System",
		from: 57,
		to: 67,
	},
	{ part: "VII", title: "Hematologic Malignancies", from: 68, to: 103 },
	{
		part: "VIII",
		title: "Hematopoietic Cell Transplantation",
		from: 104,
		to: 108,
	},
];

// "Wintrobe Ch1 · Examination of the Blood…" → { label: "Ch1", name: "Examination…" }
// Falls back to the raw title if the "·" convention ever changes.
function splitChapterTitle(title: string): { label: string; name: string } {
	const i = title.indexOf(" · ");
	if (i === -1) return { label: "", name: title };
	const lead = title.slice(0, i).replace(/^Wintrobe\s+/i, "");
	return { label: lead, name: title.slice(i + 3) };
}

export default function Lectures() {
	const [tab, setTab] = useState<LectureTab>("lectures");
	const [docs, setDocs] = useState<LectureDoc[] | null>(null);
	const [error, setError] = useState<string | null>(null);

	// Wintrobe 章節 — lazily fetched the first time the tab is opened.
	const [chapters, setChapters] = useState<TextbookChapter[] | null>(null);
	const [chaptersError, setChaptersError] = useState<string | null>(null);

	// Search state
	const [query, setQuery] = useState("");
	const [scope, setScope] = useState<LectureSearchScope>("pdf");
	const [results, setResults] = useState<LectureSearchHit[] | null>(null);
	const [searching, setSearching] = useState(false);
	const [searchError, setSearchError] = useState<string | null>(null);

	const trimmed = query.trim();
	const searchMode = trimmed.length > 0;

	// Initial registry load — unchanged from the pre-search version.
	useEffect(() => {
		let alive = true;
		listLectures()
			.then((d) => {
				if (alive) setDocs(d);
			})
			.catch((e) => {
				if (alive) setError(e?.message || "載入失敗");
			});
		return () => {
			alive = false;
		};
	}, []);

	// Lazy-load Wintrobe chapters on first visit to the「Wintrobe's」tab.
	useEffect(() => {
		if (tab !== "textbook" || chapters !== null) return;
		let alive = true;
		listTextbookChapters()
			.then((cs) => {
				if (alive) setChapters(cs);
			})
			.catch((e) => {
				if (alive) setChaptersError(e?.message || "載入失敗");
			});
		return () => {
			alive = false;
		};
	}, [tab, chapters]);

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
			<h1 className="font-serif text-3xl text-ink-900 dark:text-ink-100 mb-6">
				複習班講義
			</h1>

			<TabBar tab={tab} onTab={setTab} />

			{tab === "lectures" ? (
				<>
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
							無法載入講義:{error}
						</p>
					) : docs === null ? (
						<LectureCardSkeletonGrid count={6} />
					) : docs.length === 0 ? (
						<p className="text-ink-400 dark:text-ink-500 text-sm">
							目前還沒有任何講義。
						</p>
					) : (
						<div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
							{docs.map((d) => (
								<LectureCard key={d.slug} doc={d} />
							))}
						</div>
					)}
				</>
			) : (
				<TextbookAccordion chapters={chapters} error={chaptersError} />
			)}
		</div>
	);
}

// ── Tab bar (講義 / Wintrobe's) ────────────────────────────────────────

function TabBar({
	tab,
	onTab,
}: {
	tab: LectureTab;
	onTab: (t: LectureTab) => void;
}) {
	return (
		<div
			className="mb-6 flex gap-6 border-b border-ink-200 dark:border-ink-700"
			role="tablist"
			aria-label="講義來源"
		>
			<TabButton active={tab === "lectures"} onClick={() => onTab("lectures")}>
				複習班講義
			</TabButton>
			<TabButton active={tab === "textbook"} onClick={() => onTab("textbook")}>
				Wintrobe's
			</TabButton>
		</div>
	);
}

function TabButton({
	active,
	onClick,
	children,
}: {
	active: boolean;
	onClick: () => void;
	children: ReactNode;
}) {
	return (
		<button
			type="button"
			role="tab"
			aria-selected={active}
			onClick={onClick}
			className={
				"-mb-px border-b-2 pb-2 text-sm font-medium transition " +
				(active
					? "border-accent text-accent"
					: "border-transparent text-ink-500 dark:text-ink-400 hover:text-ink-800 dark:hover:text-ink-200")
			}
		>
			{children}
		</button>
	);
}

// ── Wintrobe's：Part 巢狀 accordion ───────────────────────────────────

function TextbookAccordion({
	chapters,
	error,
}: {
	chapters: TextbookChapter[] | null;
	error: string | null;
}) {
	if (error) {
		return (
			<p className="text-rose-600 dark:text-rose-400 text-sm">
				無法載入章節:{error}
			</p>
		);
	}
	if (chapters === null) {
		return <LectureCardSkeletonGrid count={4} />;
	}
	if (chapters.length === 0) {
		return (
			<p className="text-ink-400 dark:text-ink-500 text-sm">
				目前還沒有匯入教科書章節。
			</p>
		);
	}

	// Bucket chapters into their Part by sort_order. Anything outside the known
	// ranges lands in a trailing「其他」group so nothing silently disappears.
	const byPart = WINTROBE_PARTS.map((p) => ({
		...p,
		items: chapters.filter(
			(c) => c.sort_order >= p.from && c.sort_order <= p.to,
		),
	})).filter((p) => p.items.length > 0);
	const covered = new Set(byPart.flatMap((p) => p.items.map((c) => c.slug)));
	const orphans = chapters.filter((c) => !covered.has(c.slug));

	return (
		<div className="space-y-2">
			{byPart.map((p, idx) => (
				<PartAccordion
					key={p.part}
					part={p.part}
					title={p.title}
					items={p.items}
					defaultOpen={idx === 0}
				/>
			))}
			{orphans.length > 0 && (
				<PartAccordion
					part=""
					title="其他"
					items={orphans}
					defaultOpen={false}
				/>
			)}
		</div>
	);
}

function PartAccordion({
	part,
	title,
	items,
	defaultOpen,
}: {
	part: string;
	title: string;
	items: TextbookChapter[];
	defaultOpen: boolean;
}) {
	return (
		<details
			open={defaultOpen}
			className="group bg-white dark:bg-ink-800 border border-ink-200 dark:border-ink-700 rounded-lg overflow-hidden"
		>
			<summary className="flex items-center gap-3 px-4 py-3 cursor-pointer select-none list-none hover:bg-ink-50 dark:hover:bg-ink-700/50 transition">
				<ChevronRight
					size={16}
					className="shrink-0 text-ink-400 dark:text-ink-500 transition-transform group-open:rotate-90"
					aria-hidden="true"
				/>
				{part && (
					<span className="shrink-0 text-xs font-mono font-semibold text-accent">
						Part {part}
					</span>
				)}
				<span className="font-serif text-ink-900 dark:text-ink-100">
					{title}
				</span>
				<span className="ml-auto shrink-0 text-xs text-ink-400 dark:text-ink-500">
					{items.length} 章
				</span>
			</summary>
			<ul className="border-t border-ink-100 dark:border-ink-700/70 divide-y divide-ink-100 dark:divide-ink-700/70">
				{items.map((c) => {
					const { label, name } = splitChapterTitle(c.title);
					return (
						<li key={c.slug}>
							<Link
								to={`/lectures/${c.slug}`}
								className="flex items-baseline gap-3 px-4 py-2.5 pl-11 hover:bg-ink-50 dark:hover:bg-ink-700/50 hover:text-accent transition"
							>
								{label && (
									<span className="shrink-0 w-12 text-xs font-mono text-ink-400 dark:text-ink-500">
										{label}
									</span>
								)}
								<span className="text-sm text-ink-800 dark:text-ink-200 leading-snug">
									{name}
								</span>
								<span className="ml-auto shrink-0 text-xs text-ink-400 dark:text-ink-500">
									{c.page_count} 頁
								</span>
							</Link>
						</li>
					);
				})}
			</ul>
		</details>
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
						scope === "pdf" ? "搜尋講義 PDF 內文…" : "搜尋你的筆記內容…"
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

import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Bookmark, Highlighter, NotebookPen, Plus, Search } from "lucide-react";
import {
	lectureListCache,
	searchLectures,
	type LectureDoc,
	type LectureSearchHit,
	type LectureSearchScope,
} from "../lib/lectureApi";
import {
	FREE_NOTE_LIST_KEY,
	createFreeNote,
	freeNoteListCache,
	type FreeNoteSummary,
} from "../lib/freeNoteApi";
import {
	BOOKMARK_LIST_KEY,
	bookmarkListCache,
	type LectureBookmark,
} from "../lib/lectureApi";
import {
	matchesBookmark,
	sortBookmarks,
	type BookmarkSort,
} from "../lib/bookmarkSort";
import { HighlightedSnippet } from "../components/lecture/HighlightedSnippet";
import { TextbookToc } from "../components/lecture/TextbookToc";
import {
	LectureCardSkeletonGrid,
	LectureSearchResultSkeleton,
} from "../components/Skeleton";

// Wait this long after the last keystroke before firing the search request.
const SEARCH_DEBOUNCE_MS = 250;

// Which registry the grid is showing: 複習班講義, the Wintrobe textbook,
// 其他筆記 (the reader's own question-agnostic notes, migration 0040), or
// 書籤 (page flags dropped in the lecture reader, migration 0042).
type LectureView = "lecture" | "textbook" | "note" | "bookmark";

const TAB_TITLE: Record<LectureView, string> = {
	lecture: "複習班講義",
	textbook: "Wintrobe 教科書",
	note: "其他筆記",
	bookmark: "書籤",
};

export default function Lectures() {
	// The active tab lives in the URL (?tab=textbook) so the reader's back link
	// can return here to the right tab and the choice is shareable/bookmarkable.
	const navigate = useNavigate();
	const [searchParams, setSearchParams] = useSearchParams();
	const tabParam = searchParams.get("tab");
	const view: LectureView =
		tabParam === "textbook" || tabParam === "note" || tabParam === "bookmark"
			? tabParam
			: "lecture";
	const setView = (v: LectureView) =>
		setSearchParams(
			(prev) => {
				const next = new URLSearchParams(prev);
				if (v === "lecture") next.delete("tab");
				else next.set("tab", v);
				return next;
			},
			{ replace: true },
		);
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

	// Registry load — 走 lectureListCache,所以切回看過的分頁是即時的。
	//
	// 原本每次切分頁都 setDocs(null) 再重抓,於是來回比對講義與教科書時每一下都
	// 閃一輪骨架(#77)—— 而這份清單只有匯入時才會變。快取過期仍然先畫舊的再背景
	// 重抓,不會退回骨架。
	// 其他筆記 has its own registry (own endpoint, own shape), so it opts out.
	useEffect(() => {
		if (view === "note" || view === "bookmark") return;
		let alive = true;
		const cached = lectureListCache.peek(view);
		setDocs(cached ?? null);
		setError(null);
		if (cached && lectureListCache.isFresh(view)) return;
		lectureListCache
			.get(view)
			.then((d) => {
				if (alive) setDocs(d);
			})
			.catch((e) => {
				if (alive && !cached) setError(e?.message || "載入失敗");
			});
		return () => {
			alive = false;
		};
	}, [view]);

	// 其他筆記 —— 一次撈完(幾十則的量級),搜尋在前端就地過濾。這裡刻意
	// 不開 FTS 端點:私人筆記全部拉回來過濾比建索引便宜,而且是立即的。
	const [notes, setNotes] = useState<FreeNoteSummary[] | null>(null);
	const [notesError, setNotesError] = useState<string | null>(null);
	const [creating, setCreating] = useState(false);
	useEffect(() => {
		if (view !== "note") return;
		let alive = true;
		const cached = freeNoteListCache.peek(FREE_NOTE_LIST_KEY);
		setNotes(cached ?? null);
		setNotesError(null);
		if (cached && freeNoteListCache.isFresh(FREE_NOTE_LIST_KEY)) return;
		freeNoteListCache
			.get(FREE_NOTE_LIST_KEY)
			.then((n) => {
				if (alive) setNotes(n);
			})
			.catch((e) => {
				if (alive && !cached) setNotesError(e?.message || "載入失敗");
			});
		return () => {
			alive = false;
		};
	}, [view]);

	// 書籤 —— 同樣一次撈完(一個人幾十則的量級),排序與過濾都在前端。
	// 快取的失效寫在 lectureApi 的 addBookmark / removeBookmark 裡,不是這裡:
	// 漏掉的症狀是「在閱讀器加了書籤,回首頁看不到」,而且無聲。
	const [bookmarks, setBookmarks] = useState<LectureBookmark[] | null>(null);
	const [bookmarksError, setBookmarksError] = useState<string | null>(null);
	const [bookmarkSort, setBookmarkSort] = useState<BookmarkSort>("date");
	useEffect(() => {
		if (view !== "bookmark") return;
		let alive = true;
		const cached = bookmarkListCache.peek(BOOKMARK_LIST_KEY);
		setBookmarks(cached ?? null);
		setBookmarksError(null);
		if (cached && bookmarkListCache.isFresh(BOOKMARK_LIST_KEY)) return;
		bookmarkListCache
			.get(BOOKMARK_LIST_KEY)
			.then((b) => {
				if (alive) setBookmarks(b);
			})
			.catch((e) => {
				if (alive && !cached) setBookmarksError(e?.message || "載入失敗");
			});
		return () => {
			alive = false;
		};
	}, [view]);

	// Debounced search. The cleanup races a stale request: if the query
	// changes while a fetch is in flight, we ignore its result.
	// 其他筆記 filters locally, so it never hits this endpoint.
	useEffect(() => {
		if (view === "note" || view === "bookmark") return;
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
			{/* 標題與分頁列刻意分成兩行:標題的字數隨分頁改變(「複習班講義」/
			    「Wintrobe 教科書」/「其他筆記」),同一行的話分頁列會跟著左右漂移,
			    切換時看起來像整條在跳。分頁列自己一行,x 位置就固定了。 */}
			<div className="mb-6">
				<div className="flex flex-wrap items-center gap-x-4 gap-y-3">
					<h1 className="font-serif text-3xl text-ink-900 dark:text-ink-100">
						{TAB_TITLE[view]}
					</h1>
					{view === "note" && (
						<button
							type="button"
							onClick={async () => {
								setCreating(true);
								try {
									const { id } = await createFreeNote();
									navigate(`/notes/${id}`);
								} catch (e: any) {
									setNotesError(e?.message || "新增失敗");
									setCreating(false);
								}
							}}
							disabled={creating}
							className="ml-auto inline-flex items-center gap-1.5 rounded bg-accent hover:bg-accent-dark text-white px-3 py-1.5 text-sm disabled:opacity-50"
						>
							<Plus size={15} /> {creating ? "建立中…" : "新增筆記"}
						</button>
					)}
				</div>
				<div className="mt-3">
					<ViewTabs view={view} onView={setView} />
				</div>
			</div>

			<SearchBar
				query={query}
				onQuery={setQuery}
				scope={scope}
				onScope={setScope}
				busy={searching}
				// 其他筆記與書籤都在前端就地過濾,沒有「PDF 內文 / 筆記」這個
				// 維度可切。書籤那一頁改把排序切換放在同一個位置 —— 版面不變,
				// 而右上角本來就是「這份清單怎麼看」的地方。
				showScope={view === "lecture" || view === "textbook"}
				placeholder={
					view === "note"
						? "搜尋標題、標籤或內容…"
						: view === "bookmark"
							? "搜尋講義標題或筆記…"
							: undefined
				}
				trailing={
					view === "bookmark" ? (
						<div
							className="inline-flex self-start overflow-hidden rounded border border-ink-200 dark:border-ink-700 sm:self-auto"
							role="group"
							aria-label="排序方式"
						>
							<ScopeButton
								active={bookmarkSort === "date"}
								onClick={() => setBookmarkSort("date")}
								label="依日期"
							/>
							<ScopeButton
								active={bookmarkSort === "doc"}
								onClick={() => setBookmarkSort("doc")}
								label="依文件"
							/>
						</div>
					) : null
				}
			/>

			{view === "bookmark" ? (
				<BookmarkGrid
					bookmarks={bookmarks}
					error={bookmarksError}
					query={trimmed}
					sort={bookmarkSort}
				/>
			) : view === "note" ? (
				<FreeNoteGrid notes={notes} error={notesError} query={trimmed} />
			) : searchMode ? (
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
	view: LectureView;
	onView: (v: LectureView) => void;
}) {
	return (
		<div
			className="inline-flex rounded border border-ink-200 dark:border-ink-700 overflow-hidden"
			role="tablist"
			aria-label="講義類別"
		>
			{(["lecture", "textbook", "note", "bookmark"] as const).map((v) => (
				<ViewTab
					key={v}
					active={view === v}
					onClick={() => onView(v)}
					label={TAB_TITLE[v]}
				/>
			))}
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
	showScope = true,
	placeholder,
	trailing,
}: {
	query: string;
	onQuery: (q: string) => void;
	scope: LectureSearchScope;
	onScope: (s: LectureSearchScope) => void;
	busy: boolean;
	showScope?: boolean;
	placeholder?: string;
	/** 搜尋框右側的控制項(書籤分頁的排序切換)。 */
	trailing?: React.ReactNode;
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
						placeholder ??
						(scope === "pdf" ? "搜尋講義 PDF 內文…" : "搜尋你的筆記內容…")
					}
					aria-label="搜尋講義"
					className="w-full border border-ink-200 dark:border-ink-700 dark:bg-ink-800 rounded pl-9 pr-4 py-2 focus:outline-none focus:border-accent text-ink-900 dark:text-ink-100 placeholder:text-ink-400 dark:placeholder:text-ink-500"
				/>
			</div>
			{showScope && (
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
			)}
			{trailing}
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

// ── 其他筆記(自由筆記)───────────────────────────────────────────────

// 前端就地過濾。標題 / 標籤 / 摘要三處任一命中即可 —— 摘要只有前 140 字,
// 所以長筆記的內文深處搜不到。這是刻意的取捨:換到的是零延遲與零索引,
// 而「找自己寫過的哪一則」靠標題與標籤幾乎都夠。
function matchesNote(n: FreeNoteSummary, q: string): boolean {
	if (!q) return true;
	const needle = q.toLowerCase();
	return (
		n.title.toLowerCase().includes(needle) ||
		n.excerpt.toLowerCase().includes(needle) ||
		n.tags.some((t) => t.toLowerCase().includes(needle))
	);
}

function FreeNoteGrid({
	notes,
	error,
	query,
}: {
	notes: FreeNoteSummary[] | null;
	error: string | null;
	query: string;
}) {
	if (error) {
		return (
			<p className="text-rose-600 dark:text-rose-400 text-sm">
				無法載入筆記:{error}
			</p>
		);
	}
	if (notes === null) return <LectureCardSkeletonGrid count={6} />;
	if (notes.length === 0) {
		return (
			<div className="bg-ink-50 dark:bg-ink-800/60 border border-dashed border-ink-200 dark:border-ink-700 rounded-lg p-8 text-center">
				<p className="text-ink-500 dark:text-ink-400">
					還沒有任何筆記。這裡放的是不屬於某一題的整理 —— 疾病總覽、
					機轉、讀書心得都可以。
				</p>
			</div>
		);
	}

	const shown = notes.filter((n) => matchesNote(n, query));
	if (shown.length === 0) {
		return (
			<p className="text-ink-400 dark:text-ink-500 text-sm">
				沒有找到符合的筆記。
			</p>
		);
	}

	return (
		<div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
			{shown.map((n) => (
				<FreeNoteCard key={n.id} note={n} />
			))}
		</div>
	);
}

function FreeNoteCard({ note }: { note: FreeNoteSummary }) {
	return (
		<Link
			to={`/notes/${note.id}`}
			className="group flex flex-col bg-white dark:bg-ink-800 border border-ink-200 dark:border-ink-700 rounded-lg p-4 hover:border-accent transition"
		>
			<h2 className="font-serif text-lg leading-snug text-ink-900 dark:text-ink-100 group-hover:text-accent transition">
				{note.title || "(未命名筆記)"}
			</h2>
			{note.excerpt && (
				<p className="mt-1 text-sm text-ink-500 dark:text-ink-400 line-clamp-3">
					{note.excerpt}
				</p>
			)}
			<div className="mt-auto pt-4 flex flex-wrap items-center gap-1.5 text-xs">
				{note.tags.slice(0, 3).map((t) => (
					<span
						key={t}
						className="rounded-full bg-accent/10 text-accent px-1.5 py-0.5"
					>
						{t}
					</span>
				))}
				<span className="ml-auto text-ink-400 dark:text-ink-500 shrink-0">
					{new Date(note.updated_at).toLocaleDateString("zh-TW")}
				</span>
			</div>
		</Link>
	);
}

// ── 書籤(migration 0042)───────────────────────────────────────────────

function BookmarkGrid({
	bookmarks,
	error,
	query,
	sort,
}: {
	bookmarks: LectureBookmark[] | null;
	error: string | null;
	query: string;
	sort: BookmarkSort;
}) {
	if (error) {
		return (
			<p className="text-rose-600 dark:text-rose-400 text-sm">
				無法載入書籤:{error}
			</p>
		);
	}
	if (bookmarks === null) return <LectureCardSkeletonGrid count={6} />;
	if (bookmarks.length === 0) {
		return (
			<div className="bg-ink-50 dark:bg-ink-800/60 border border-dashed border-ink-200 dark:border-ink-700 rounded-lg p-8 text-center">
				<p className="text-ink-500 dark:text-ink-400">
					還沒有書籤。在講義閱讀器的工具列按
					<Bookmark size={14} className="mx-1 inline align-[-2px]" />
					可以把當下那一頁記下來,之後從這裡直接跳回去。
				</p>
			</div>
		);
	}

	const shown = sortBookmarks(
		bookmarks.filter((b) => matchesBookmark(b, query)),
		sort,
	);
	if (shown.length === 0) {
		return (
			<p className="text-ink-400 dark:text-ink-500 text-sm">
				沒有找到符合的書籤。
			</p>
		);
	}

	return (
		<div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
			{shown.map((b) => (
				<BookmarkCard key={b.id} bookmark={b} />
			))}
		</div>
	);
}

function BookmarkCard({ bookmark: b }: { bookmark: LectureBookmark }) {
	return (
		<Link
			to={`/lectures/${b.slug}?page=${b.page}`}
			className="group flex flex-col bg-white dark:bg-ink-800 border border-ink-200 dark:border-ink-700 rounded-lg p-4 hover:border-accent transition"
		>
			<div className="flex items-baseline gap-2">
				<h2 className="min-w-0 flex-1 font-serif text-lg leading-snug text-ink-900 dark:text-ink-100 group-hover:text-accent transition">
					{b.title}
				</h2>
				<span className="shrink-0 font-mono text-xs text-ink-500 dark:text-ink-400">
					p.{b.page}
				</span>
			</div>
			{b.instructor && (
				<p className="mt-0.5 text-xs text-ink-500 dark:text-ink-400">
					{b.instructor}
				</p>
			)}
			{/* 預覽是「這一頁的講義筆記」。那一頁沒寫過筆記就留白 —— 補一句
			    「(尚無筆記)」只是把每一張卡片都填滿灰字,反而更難掃過去。 */}
			{b.note_preview && (
				<p className="mt-2 text-sm leading-relaxed text-ink-600 dark:text-ink-300 line-clamp-2">
					{b.note_preview}
				</p>
			)}
			<div className="mt-auto pt-4 flex items-center gap-2 text-xs text-ink-400 dark:text-ink-500">
				<Bookmark size={12} />
				<span className="ml-auto">
					{new Date(b.created_at).toLocaleDateString("zh-TW")}
				</span>
			</div>
		</Link>
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

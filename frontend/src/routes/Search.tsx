import {
	useEffect,
	useRef,
	useState,
	useCallback,
	useLayoutEffect,
} from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
	Search as SearchIcon,
	X as XIcon,
	FolderPlus,
	Clock,
	Sparkles,
} from "lucide-react";
import { api } from "../lib/api";
import { ExplanationPeek } from "../components/ExplanationPeek";
import { QuestionResultCard } from "../components/QuestionResultCard";
import { SearchExpandDialog } from "../components/SearchExpandDialog";
import { queryTerms } from "../lib/markTerms";
import { rowTitle } from "../lib/questionRow";
import { useBookmarkSet } from "../hooks/useBookmarkSet";
import { ExportButton } from "../components/ExportDialog";
import { GROUPS } from "../lib/groups";
import {
	type Hit,
	setSearchCache,
	getSearchCache,
	setSearchScroll,
} from "../lib/searchCache";

type Year = { year: number; count: number };
type Tag = { tag: string; count: number };
type HistoryItem = { query: string; created_at: number };
type Sort = "relevance" | "year";
type Answered = "all" | "yes" | "no";

export function Search() {
	const [sp, setSp] = useSearchParams();
	const initialQ = sp.get("q") || "";
	const [q, setQ] = useState(initialQ);
	const [year, setYear] = useState<string>(sp.get("year") || "");
	const [group, setGroup] = useState<string>(sp.get("group") || "");
	const [sort, setSort] = useState<Sort>(
		sp.get("sort") === "year" ? "year" : "relevance",
	);
	const [answered, setAnswered] = useState<Answered>(
		sp.get("answered") === "yes"
			? "yes"
			: sp.get("answered") === "no"
				? "no"
				: "all",
	);
	const [tagSet, setTagSet] = useState<Set<string>>(
		new Set((sp.get("tags") || "").split(",").filter(Boolean)),
	);
	const [years, setYears] = useState<Year[]>([]);
	const [allTags, setAllTags] = useState<Tag[]>([]);
	const bookmarkSet = useBookmarkSet();
	const [hits, setHits] = useState<Hit[] | null>(null);
	const [searching, setSearching] = useState(false);
	const [savePromptOpen, setSavePromptOpen] = useState(false);
	const [folderName, setFolderName] = useState("");
	const [saving, setSaving] = useState(false);
	const [savedNotice, setSavedNotice] = useState<string | null>(null);
	// 檢討介面的兩件事,判準與成績頁 / 錯題回顧完全一致(見 components/AnswerOptions)。
	const [expandAll, setExpandAll] = useState(false);
	// 「查看詳解」開起來的那一題。存 id + 稱呼而不是整列 —— 對話框只需要這兩個。
	const [peek, setPeek] = useState<{ id: string; title: string } | null>(null);
	const [expandOpen, setExpandOpen] = useState(false);
	// 要在題幹裡標起來的字。**用送出當下那一份查詢**(`hits` 是那次查詢的結果),
	// 不是輸入框現在的內容 —— 否則使用者一邊改字,舊結果上的標記就會跟著跳。
	const [marks, setMarks] = useState<string[]>([]);

	// Recent-searches dropdown
	const [history, setHistory] = useState<HistoryItem[]>([]);
	const [showHistory, setShowHistory] = useState(false);
	const searchBoxRef = useRef<HTMLDivElement>(null);

	// The cache key is the exact query string result links stash as `fromSearch`
	// (`?<params>`), so the question page can look this result set up by it.
	const cacheKey = `?${sp.toString()}`;

	useEffect(() => {
		api.get<Year[]>("/api/questions/_meta/years").then(setYears);
		api.get<Tag[]>("/api/questions/_meta/tags").then(setAllTags);
	}, []);

	// Build the query params for the current filter state, optionally overriding
	// the keyword (used when replaying a picked history entry).
	const buildParams = useCallback(
		(queryOverride?: string) => {
			const kw = (queryOverride ?? q).trim();
			const params = new URLSearchParams();
			if (kw) params.set("q", kw);
			if (year) params.set("year", year);
			if (group) params.set("group", group);
			if (sort === "year") params.set("sort", "year");
			if (answered !== "all") params.set("answered", answered);
			if (tagSet.size > 0) params.set("tags", [...tagSet].join(","));
			return params;
		},
		[q, year, group, sort, answered, tagSet],
	);

	const runSearch = useCallback(
		async (params: URLSearchParams) => {
			setSearching(true);
			setShowHistory(false);
			try {
				setSp(params, { replace: true });
				const r = await api.get<{ items: Hit[] }>(`/api/search?${params}`);
				setHits(r.items);
				// 標記的依據**跟著這一次送出的查詢走**,不是輸入框當下的內容 ——
				// 否則使用者一邊改字,舊結果上的標記就會跟著跳。
				setMarks(queryTerms(params.get("q") ?? ""));
				setSearchCache(`?${params}`, r.items);
			} finally {
				setSearching(false);
			}
		},
		[setSp],
	);

	const doSearch = useCallback(
		() => runSearch(buildParams()),
		[runSearch, buildParams],
	);

	// On mount: restore the cached result set (instant, no flicker) when the
	// query matches; otherwise run the search if the URL carried params.
	useEffect(() => {
		const cached = getSearchCache();
		if (cached && cached.key === cacheKey) {
			setHits(cached.hits);
			// 從題目頁走回來時也要標 —— 少了這行,回到清單標記會整批消失,
			// 看起來像「重新整理就壞了」。
			setMarks(queryTerms(initialQ));
			return;
		}
		if (initialQ || sp.get("year") || sp.get("group") || sp.get("tags")) {
			doSearch();
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// Restore scroll after cached hits paint so returning lands where the user
	// left off.
	useLayoutEffect(() => {
		const cached = getSearchCache();
		if (cached && cached.key === cacheKey && hits && cached.scrollY > 0) {
			window.scrollTo(0, cached.scrollY);
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [hits]);

	// Keep the cached scroll offset fresh while the user scrolls the results.
	useEffect(() => {
		function onScroll() {
			setSearchScroll(cacheKey, window.scrollY);
		}
		window.addEventListener("scroll", onScroll, { passive: true });
		return () => window.removeEventListener("scroll", onScroll);
	}, [cacheKey]);

	// Close the history dropdown on outside click.
	useEffect(() => {
		if (!showHistory) return;
		function onDown(e: MouseEvent) {
			if (
				searchBoxRef.current &&
				!searchBoxRef.current.contains(e.target as Node)
			) {
				setShowHistory(false);
			}
		}
		document.addEventListener("mousedown", onDown);
		return () => document.removeEventListener("mousedown", onDown);
	}, [showHistory]);

	async function openHistory() {
		try {
			const r = await api.get<{ items: HistoryItem[] }>(
				"/api/search/history?limit=10",
			);
			setHistory(r.items);
			if (r.items.length > 0) setShowHistory(true);
		} catch {
			/* history is a nicety — never block searching on it */
		}
	}

	function pickHistory(query: string) {
		setQ(query);
		runSearch(buildParams(query));
	}

	async function removeHistory(e: React.MouseEvent, query: string) {
		e.stopPropagation();
		setHistory((prev) => prev.filter((h) => h.query !== query));
		try {
			await api.del(`/api/search/history?query=${encodeURIComponent(query)}`);
		} catch {
			/* optimistic removal is fine for a personal dropdown */
		}
	}

	function toggleTag(t: string) {
		setTagSet((prev) => {
			const next = new Set(prev);
			if (next.has(t)) next.delete(t);
			else next.add(t);
			return next;
		});
	}

	async function saveResults() {
		if (!hits || hits.length === 0 || saving) return;
		const name = folderName.trim();
		if (!name) return;
		setSaving(true);
		try {
			const folder = await api.post<{ id: string; name: string }>(
				"/api/folders",
				{ name },
			);
			const r = await api.post<{ inserted: number }>("/api/bookmarks/bulk", {
				question_ids: hits.map((h) => h.id),
				folder_id: folder.id,
			});
			setSavePromptOpen(false);
			setFolderName("");
			setSavedNotice(`已存 ${r.inserted} 題到資料夾「${folder.name}」`);
			setTimeout(() => setSavedNotice(null), 5000);
			// bulk-save adds bookmarks across the result set; refresh the global
			// bookmark set so the badge appears immediately everywhere.
			bookmarkSet.reload();
		} catch (e) {
			alert("儲存失敗:" + String(e));
		} finally {
			setSaving(false);
		}
	}

	return (
		<div className="max-w-4xl lg:max-w-5xl xl:max-w-6xl mx-auto px-4 sm:px-6 py-8">
			<div className="flex items-center justify-between gap-4 mb-6">
				<h1 className="font-serif text-3xl text-ink-900 dark:text-ink-100 inline-flex items-center gap-2">
					<SearchIcon size={26} /> 搜尋
				</h1>
				{hits && hits.length > 0 && (
					// 搜尋結果刻意用 ids scope:worker 端不複製 search.ts 的 FTS 查詢。
					<ExportButton
						scope={{
							kind: "ids",
							ids: hits.map((h) => h.id),
							label: "搜尋結果",
						}}
					/>
				)}
			</div>

			<form
				onSubmit={(e) => {
					e.preventDefault();
					doSearch();
				}}
				className="flex gap-2 mb-4"
			>
				<div ref={searchBoxRef} className="relative flex-1">
					<input
						autoFocus
						value={q}
						onChange={(e) => setQ(e.target.value)}
						onFocus={() => {
							if (!q.trim()) openHistory();
						}}
						placeholder="關鍵字 (例:AML、Factor VIII、誘導化療)"
						className="w-full px-4 py-2.5 border border-ink-200 dark:border-ink-700 rounded text-base focus:outline-none focus:border-accent bg-white dark:bg-ink-800 text-ink-900 dark:text-ink-100"
					/>
					{showHistory && history.length > 0 && (
						<ul className="absolute z-20 mt-1 w-full max-h-72 overflow-auto rounded border border-ink-200 dark:border-ink-700 bg-white dark:bg-ink-800 shadow-paper">
							<li className="px-3 py-1.5 text-[11px] uppercase tracking-wide text-ink-400 dark:text-ink-500 flex items-center gap-1.5">
								<Clock size={12} /> 最近搜尋
							</li>
							{history.map((h) => (
								<li key={h.query}>
									<div
										role="button"
										tabIndex={0}
										onClick={() => pickHistory(h.query)}
										onKeyDown={(e) => {
											if (e.key === "Enter") pickHistory(h.query);
										}}
										className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm text-ink-800 dark:text-ink-200 hover:bg-ink-50 dark:hover:bg-ink-700/60 cursor-pointer"
									>
										<SearchIcon
											size={13}
											className="text-ink-400 dark:text-ink-500 shrink-0"
										/>
										<span className="truncate flex-1">{h.query}</span>
										<span
											onClick={(e) => removeHistory(e, h.query)}
											className="text-ink-400 hover:text-rose-600 dark:hover:text-rose-400 shrink-0"
											aria-label={`移除「${h.query}」`}
										>
											<XIcon size={13} />
										</span>
									</div>
								</li>
							))}
						</ul>
					)}
				</div>
				{/* 在搜尋鈕左邊。**沒有關鍵字時停用** —— 沒有東西可以展開,而一顆按了
				    不會有任何變化的按鈕比沒有這顆更糟(同成績頁「登記進複習進度」)。 */}
				<button
					type="button"
					disabled={!q.trim()}
					onClick={() => setExpandOpen(true)}
					title="用 AI 想出這個詞的各種寫法(縮寫、全名、單複數、中英),一次全部搜"
					className="inline-flex items-center gap-1.5 shrink-0 px-3 py-2.5 rounded border border-ink-200 dark:border-ink-700 text-ink-600 dark:text-ink-300 hover:border-accent hover:text-accent transition disabled:opacity-40 disabled:hover:border-ink-200 disabled:hover:text-ink-600"
				>
					<Sparkles size={15} />
					<span className="hidden sm:inline">AI 進階搜尋</span>
				</button>
				<button
					type="submit"
					disabled={searching}
					className="bg-accent hover:bg-accent-dark text-white px-5 py-2.5 rounded font-medium disabled:opacity-40"
				>
					{searching ? "搜尋中…" : "搜尋"}
				</button>
			</form>

			{/* Filters */}
			<div className="flex flex-wrap gap-2 mb-4 items-center text-sm">
				<select
					value={year}
					onChange={(e) => setYear(e.target.value)}
					className="px-3 py-1.5 border border-ink-200 dark:border-ink-700 rounded bg-white dark:bg-ink-800 text-ink-800 dark:text-ink-200"
				>
					<option value="">所有年度</option>
					{years.map((y) => (
						<option key={y.year} value={y.year}>
							民國 {y.year}
							{y.year === 100 ? " (模擬)" : ""}
						</option>
					))}
				</select>
				<select
					value={group}
					onChange={(e) => setGroup(e.target.value)}
					className="px-3 py-1.5 border border-ink-200 dark:border-ink-700 rounded bg-white dark:bg-ink-800 text-ink-800 dark:text-ink-200"
				>
					<option value="">所有 group</option>
					{GROUPS.map((g) => (
						<option key={g.label} value={g.label}>
							{g.label}
						</option>
					))}
				</select>
				<select
					value={sort}
					onChange={(e) => setSort(e.target.value as Sort)}
					className="px-3 py-1.5 border border-ink-200 dark:border-ink-700 rounded bg-white dark:bg-ink-800 text-ink-800 dark:text-ink-200"
					aria-label="排序方式"
				>
					<option value="relevance">相關度排序</option>
					<option value="year">年份排序</option>
				</select>
				<select
					value={answered}
					onChange={(e) => setAnswered(e.target.value as Answered)}
					className="px-3 py-1.5 border border-ink-200 dark:border-ink-700 rounded bg-white dark:bg-ink-800 text-ink-800 dark:text-ink-200"
					aria-label="作答狀態"
				>
					<option value="all">全部作答狀態</option>
					<option value="yes">已作答</option>
					<option value="no">未作答</option>
				</select>
				{tagSet.size > 0 && (
					<button
						onClick={() => setTagSet(new Set())}
						className="text-xs text-ink-500 dark:text-ink-400 hover:text-rose-600 dark:hover:text-rose-400 inline-flex items-center gap-1"
					>
						<XIcon size={12} /> 清除 {tagSet.size} 個 tag
					</button>
				)}
			</div>

			{/* Tag chips */}
			{allTags.length > 0 && (
				<div className="flex flex-wrap gap-1.5 mb-6">
					{allTags.slice(0, 40).map((t) => {
						const on = tagSet.has(t.tag);
						return (
							<button
								key={t.tag}
								onClick={() => toggleTag(t.tag)}
								className={
									"text-[11px] px-2 py-0.5 rounded transition " +
									(on
										? "bg-accent text-white"
										: "bg-ink-100 dark:bg-ink-700 text-ink-700 dark:text-ink-200 hover:bg-ink-200 dark:hover:bg-ink-600")
								}
							>
								#{t.tag} <span className="opacity-60">{t.count}</span>
							</button>
						);
					})}
				</div>
			)}

			{/* Results */}
			{hits === null ? (
				<p className="text-ink-400 dark:text-ink-500 text-sm">
					輸入關鍵字或選 filter 開始搜尋。
				</p>
			) : hits.length === 0 ? (
				<p className="text-ink-400 dark:text-ink-500 text-sm">
					沒有符合的題目。
				</p>
			) : (
				<>
					<div className="flex items-center justify-between mb-3 gap-3 flex-wrap">
						<p className="text-xs text-ink-500 dark:text-ink-400">
							{hits.length} 筆結果
						</p>
						<div className="flex items-center gap-2">
							{/* 「把這些出成一份測驗」——同錯題回顧那條入口。
							    ⚠️ **帶的是題號清單,不是篩選條件。** 這一頁的條件是全文檢索,
							    沒有辦法用 status/year/group/tag 表達出來(錯題回顧可以,所以它
							    帶的是 query string)。伺服器那側 `ids` 與其他條件是 AND,
							    於是「從這批結果裡只出我答錯的」在出卷頁勾一下就有。 */}
							<Link
								to={`/exam/new?ids=${hits.map((h) => h.id).join(",")}`}
								className="text-xs text-accent hover:text-accent-dark whitespace-nowrap"
							>
								把這 {hits.length} 題出成測驗 →
							</Link>
							{/* 同成績頁與錯題回顧:一次把所有卡片推到同一個狀態,之後每一題
                  仍然可以單獨開關。 */}
							<button
								type="button"
								onClick={() => setExpandAll((v) => !v)}
								aria-pressed={expandAll}
								className="text-xs px-2.5 py-1 rounded border border-ink-200 dark:border-ink-700 text-ink-600 dark:text-ink-300 hover:border-ink-400 dark:hover:border-ink-500 transition"
							>
								{expandAll ? "收合全部選項" : "展開全部選項"}
							</button>
							{savedNotice && (
								<span className="text-xs text-emerald-700 dark:text-emerald-300">
									{savedNotice}
								</span>
							)}
							{!savePromptOpen ? (
								<button
									onClick={() => setSavePromptOpen(true)}
									className="text-xs text-accent hover:text-accent-dark inline-flex items-center gap-1.5"
								>
									<FolderPlus size={14} /> 儲存為收藏資料夾
								</button>
							) : (
								<form
									onSubmit={(e) => {
										e.preventDefault();
										saveResults();
									}}
									className="flex items-center gap-1.5"
								>
									<input
										autoFocus
										value={folderName}
										onChange={(e) => setFolderName(e.target.value)}
										placeholder="資料夾名稱"
										maxLength={40}
										className="px-2 py-1 border border-ink-200 dark:border-ink-700 rounded text-xs bg-white dark:bg-ink-800 text-ink-900 dark:text-ink-100 focus:outline-none focus:border-accent"
									/>
									<button
										type="submit"
										disabled={saving || !folderName.trim()}
										className="bg-accent hover:bg-accent-dark text-white px-3 py-1 rounded text-xs font-medium disabled:opacity-40"
									>
										{saving ? "存…" : "存"}
									</button>
									<button
										type="button"
										onClick={() => {
											setSavePromptOpen(false);
											setFolderName("");
										}}
										disabled={saving}
										className="text-xs text-ink-500 dark:text-ink-400 hover:text-ink-700 dark:hover:text-ink-200"
									>
										取消
									</button>
								</form>
							)}
						</div>
					</div>
					<ul className="space-y-2">
						{hits.map((h) => (
							<li key={h.id}>
								{/* 四頁共用同一張卡(見 components/QuestionResultCard)。
								    題幹**整段顯示**:舊版是 FTS5 的 snippet() 片段,連題目在問
								    什麼都看不到 —— 命中的字改成在 client 標。 */}
								<QuestionResultCard
									row={h}
									highlight={marks}
									linkState={{ fromSearch: cacheKey }}
									expandAll={expandAll}
									onPeek={() => setPeek({ id: h.id, title: rowTitle(h) })}
								/>
							</li>
						))}
					</ul>
				</>
			)}

			{expandOpen && (
				<SearchExpandDialog
					query={q.trim()}
					onClose={() => setExpandOpen(false)}
					onApply={(next) => {
						setExpandOpen(false);
						setQ(next);
						// 直接搜,不要讓使用者再按一次 —— 他按那顆按鈕的意圖就是
						// 「用這些字去找」。`buildParams` 讀的是 state,而 setQ 這一幀
						// 還沒生效,所以用 override。
						void runSearch(buildParams(next));
					}}
				/>
			)}

			{peek && (
				<ExplanationPeek
					questionId={peek.id}
					label={peek.title}
					onClose={() => setPeek(null)}
				/>
			)}
		</div>
	);
}

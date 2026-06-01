import { useEffect, useState, useMemo } from "react";
import { useParams, Link, useNavigate, useLocation } from "react-router-dom";
import {
	ChevronLeft,
	ChevronRight,
	Pencil,
	LinkIcon,
	Sparkles,
	Search as SearchIcon,
	Eye,
	X as XIcon,
	ExternalLink,
} from "lucide-react";
import { api, ApiError } from "../lib/api";
import { buildOpenEvidenceUrl } from "../lib/openevidence";
import { useQuestion } from "../hooks/useQuestion";
import { useLock } from "../hooks/useLock";
import { useMe } from "../hooks/useMe";
import { QuestionCard } from "../components/QuestionCard";
import { RichEditor } from "../components/RichEditor";
import { ReadOnlyContent } from "../components/ReadOnlyContent";
import { CommentThread } from "../components/CommentThread";
import { BookmarkBadge } from "../components/BookmarkBadge";

type Tab = "explanation" | "note" | "discussion";

type SimilarItem = {
	id: string;
	year: number;
	number: number;
	stem: string;
	group: string | null;
	shared_tags: number;
	source: "tag" | "fts";
};

type AiKind = "summary" | "translate" | "qa";
type AiQaItem = {
	question: string;
	answer: string[];
};
type AiOutput =
	| { kind: "summary" | "translate"; text: string; version: number }
	| { kind: "qa"; items: AiQaItem[]; version: number };

export function Question() {
	const { id } = useParams<{ id: string }>();
	const { me } = useMe();
	const { data, error, reload } = useQuestion(id);
	const { state: lockState, acquire, release } = useLock(id || "");

	const [tab, setTab] = useState<Tab>("explanation");
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState<any>(null);
	const [saving, setSaving] = useState(false);
	const [saveError, setSaveError] = useState<string | null>(null);
	// 詳解 spoiler guard — start blurred on every question so users don't see
	// the answer before attempting. CSS-only blur on the already-rendered
	// ReadOnlyContent, so no extra render pass and no content duplication.
	const [revealedExp, setRevealedExp] = useState(false);
	// Live comment count for the 討論串 tab badge. Seeded from the question
	// API's comment_count (so the badge is correct on first paint without
	// mounting CommentThread), then kept fresh by CommentThread's onCountChange
	// whenever a comment is added/edited/deleted.
	const [commentCount, setCommentCount] = useState(0);

	// Note tab — has its own edit lifecycle (no lock, no version)
	const [noteEditing, setNoteEditing] = useState(false);
	const [noteDraft, setNoteDraft] = useState<any>(null);
	const [noteSaving, setNoteSaving] = useState(false);
	const [noteError, setNoteError] = useState<string | null>(null);

	// AI panel — one shared display for 摘要 / 翻譯 / 生成問答.
	// `version` is the explanation version snapshot so we can invalidate
	// stale output when the explanation moves forward.
	const [aiOutput, setAiOutput] = useState<AiOutput | null>(null);
	const [aiLoading, setAiLoading] = useState<AiKind | null>(null);
	const [aiError, setAiError] = useState<{
		kind: AiKind;
		message: string;
	} | null>(null);

	const explanationJson = useMemo(() => {
		if (!data?.explanation?.content_json) return null;
		try {
			return JSON.parse(data.explanation.content_json);
		} catch {
			return null;
		}
	}, [data?.explanation?.content_json]);

	const noteJson = useMemo(() => {
		if (!data?.my_note?.content_json) return null;
		try {
			return JSON.parse(data.my_note.content_json);
		} catch {
			return null;
		}
	}, [data?.my_note?.content_json]);

	// Invalidate cached AI output when its source (explanation version) changes.
	useEffect(() => {
		const v = data?.explanation?.version ?? 0;
		if (aiOutput && aiOutput.version !== v) {
			setAiOutput(null);
			setAiError(null);
		}
	}, [data?.explanation?.version, aiOutput]);

	// Re-blur the 詳解 whenever the user navigates to a different question
	// (prev/next, similar, back-refs, deep link). Same component instance, so
	// useState alone wouldn't reset.
	useEffect(() => {
		setRevealedExp(false);
	}, [data?.id]);

	// Seed/refresh the comment-count badge from the question payload. Kept in
	// sync via onCountChange when CommentThread is mounted.
	useEffect(() => {
		if (typeof data?.comment_count === "number") {
			setCommentCount(data.comment_count);
		}
	}, [data?.id, data?.comment_count]);

	// If the user is on the discussion tab and the viewport shrinks below lg
	// (where the tab is hidden), snap them back to the explanation tab so they
	// aren't stuck on an invisible tab with no content.
	useEffect(() => {
		if (tab !== "discussion") return;
		const mq = window.matchMedia("(min-width: 1024px)");
		const sync = () => {
			if (!mq.matches) setTab("explanation");
		};
		sync();
		mq.addEventListener("change", sync);
		return () => mq.removeEventListener("change", sync);
	}, [tab]);

	// 相似題目 — lazy-loaded after the main question payload arrives.
	// Kept off the hot /api/questions/:id path so navigation stays snappy.
	const [similar, setSimilar] = useState<SimilarItem[]>([]);
	useEffect(() => {
		if (!data?.id) return;
		let cancelled = false;
		api
			.get<SimilarItem[]>(`/api/questions/${data.id}/similar`)
			.then((rows) => {
				if (!cancelled) setSimilar(rows);
			})
			.catch(() => {
				if (!cancelled) setSimilar([]);
			});
		return () => {
			cancelled = true;
		};
	}, [data?.id]);

	const navigate = useNavigate();
	const location = useLocation();
	// When the user reached this page from /search, the Search route stashes the
	// original query string in history state so we can offer a "回搜尋結果" link
	// alongside the year link. Survives refresh (history.state) and prev/next
	// navigation (we re-pass state below), but a fresh deep-link won't have it —
	// which is correct: there's no search to go back to.
	const fromSearch = (location.state as { fromSearch?: string } | null)
		?.fromSearch;

	// Prev/next in same year
	const [neighbors, setNeighbors] = useState<{ prev?: string; next?: string }>(
		{},
	);
	useEffect(() => {
		if (!data) return;
		api
			.get<{ id: string; number: number }[]>(
				`/api/questions?year=${data.year}&limit=200`,
			)
			.then((all) => {
				const idx = all.findIndex((q) => q.id === data.id);
				setNeighbors({
					prev: idx > 0 ? all[idx - 1].id : undefined,
					next: idx < all.length - 1 ? all[idx + 1].id : undefined,
				});
			});
	}, [data?.id]);

	async function startEdit() {
		if (!data) return;
		const ok = await acquire();
		if (!ok) return;
		setDraft(
			explanationJson || { type: "doc", content: [{ type: "paragraph" }] },
		);
		setEditing(true);
		setSaveError(null);
	}

	async function cancelEdit() {
		setEditing(false);
		setDraft(null);
		setSaveError(null);
		await release();
	}

	async function save() {
		if (!data || saving) return;
		setSaving(true);
		setSaveError(null);
		try {
			await api.put(`/api/questions/${data.id}/explanation`, {
				content_json: draft,
				expected_version: data.explanation?.version ?? 0,
			});
			setEditing(false);
			setDraft(null);
			await release();
			await reload();
		} catch (e) {
			if (e instanceof ApiError && e.status === 409) {
				setSaveError(
					`版本衝突:伺服器已是 v${e.data?.server_version},你編輯的是 v${e.data?.your_version}。請取消並重新載入。`,
				);
			} else if (e instanceof ApiError && e.status === 423) {
				setSaveError("編輯鎖已被其他人取得,無法儲存。");
			} else {
				setSaveError(String(e));
			}
		} finally {
			setSaving(false);
		}
	}

	function startNoteEdit() {
		if (!data) return;
		setNoteDraft(noteJson || { type: "doc", content: [{ type: "paragraph" }] });
		setNoteEditing(true);
		setNoteError(null);
	}

	function cancelNoteEdit() {
		setNoteEditing(false);
		setNoteDraft(null);
		setNoteError(null);
	}

	async function runAi(kind: AiKind) {
		if (!data || aiLoading) return;
		const version = data.explanation?.version ?? 0;
		setAiLoading(kind);
		setAiError(null);
		try {
			if (kind === "summary") {
				if (!explanationJson) throw new Error("尚無詳解可摘要");
				const plain = tiptapToText(explanationJson);
				if (plain.length < 50) throw new Error("詳解內容太短,無法摘要。");
				const r = await api.post<{ summary: string }>("/api/ai/summarize", {
					text: plain,
				});
				setAiOutput({ kind, text: r.summary, version });
			} else if (kind === "qa") {
				if (!explanationJson) throw new Error("尚無詳解可生成問答");
				const plain = tiptapToText(explanationJson);
				if (plain.length < 80) throw new Error("詳解內容太短,無法生成問答。");
				const r = await api.post<{ items: AiQaItem[] }>(
					"/api/ai/generate-qa",
					{
						stem: data.stem,
						options: data.options,
						answer: data.answer,
						tags: data.tags,
						explanation: plain,
					},
				);
				if (!r.items?.length) throw new Error("AI 未產生可用問答。");
				setAiOutput({ kind, items: r.items, version });
			} else {
				if (!explanationJson) throw new Error("尚無詳解可翻譯");
				const plain = tiptapToText(explanationJson);
				if (plain.length < 2) throw new Error("詳解內容太短,無法翻譯。");
				const r = await api.post<{ text: string }>("/api/ai/translate-zh-tw", {
					text: plain,
				});
				setAiOutput({ kind, text: r.text, version });
			}
		} catch (e) {
			setAiError({ kind, message: e instanceof Error ? e.message : String(e) });
		} finally {
			setAiLoading(null);
		}
	}

	async function saveNote() {
		if (!data || noteSaving) return;
		setNoteSaving(true);
		setNoteError(null);
		try {
			await api.put(`/api/questions/${data.id}/note`, {
				content_json: noteDraft,
			});
			setNoteEditing(false);
			setNoteDraft(null);
			await reload();
		} catch (e) {
			setNoteError(String(e));
		} finally {
			setNoteSaving(false);
		}
	}

	// While we have data, keep rendering even during a refetch — this is the
	// common case after saving 詳解, where blanking the page would feel jarring.
	if (!data) {
		if (error)
			return (
				<div className="p-8 text-center text-rose-700">
					載入失敗:{String(error)}
				</div>
			);
		return <div className="p-8 text-center text-ink-400 dark:text-ink-500">載入中…</div>;
	}

	const hasExplanation =
		explanationJson &&
		explanationJson.content &&
		explanationJson.content.length > 0 &&
		!(
			explanationJson.content.length === 1 &&
			explanationJson.content[0].type === "paragraph" &&
			!explanationJson.content[0].content
		);

	return (
		<div className="max-w-3xl md:max-w-4xl lg:max-w-6xl xl:max-w-[88rem] 2xl:max-w-[104rem] mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-8 pb-32">
			<header className="flex items-center justify-between mb-6 text-sm gap-3">
				<div className="flex items-center gap-3 flex-wrap">
					{fromSearch && (
						<Link
							to={`/search${fromSearch}`}
							className="inline-flex items-center gap-1 text-ink-500 dark:text-ink-400 hover:text-accent"
						>
							<ChevronLeft size={16} />
							<SearchIcon size={13} /> 搜尋結果
						</Link>
					)}
					<Link
						to={`/year/${data.year}`}
						className="inline-flex items-center gap-1 text-ink-500 dark:text-ink-400 hover:text-accent"
					>
						<ChevronLeft size={16} /> 民國 {data.year} 年
					</Link>
				</div>
				<div className="flex gap-3">
					{neighbors.prev && (
						<button
							onClick={() =>
								navigate(`/q/${neighbors.prev}`, { state: location.state })
							}
							className="inline-flex items-center gap-1 text-ink-500 dark:text-ink-400 hover:text-accent"
						>
							<ChevronLeft size={16} /> 上一題
						</button>
					)}
					{neighbors.next && (
						<button
							onClick={() =>
								navigate(`/q/${neighbors.next}`, { state: location.state })
							}
							className="inline-flex items-center gap-1 text-ink-500 dark:text-ink-400 hover:text-accent"
						>
							下一題 <ChevronRight size={16} />
						</button>
					)}
				</div>
			</header>

			{/* Two-column on wide screens (≥lg): question left, everything else right.
			    Collapses to a single stacked column below lg. */}
			<div className="lg:grid lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-8 lg:items-start">
			{/* Left: question stem / options / answer — pinned in view while the right scrolls */}
			<div className="lg:sticky lg:top-20 lg:self-start">
			<QuestionCard
				key={data.id}
				question={data}
				onAnswered={reload}
				onProgressCleared={reload}
			/>
			</div>

			{/* Right: 詳解共筆 / 個人筆記 tabs → 相似題目 → 被引用 → 討論 */}
			<div className="mt-8 lg:mt-0">

			{/* 詳解 / 個人筆記 tabs */}
			<section className="mt-0">
				<div className="flex items-center justify-between mb-3 gap-3">
					<div className="inline-flex border-b border-ink-200 dark:border-ink-700">
						<TabButton
							active={tab === "explanation"}
							onClick={() => setTab("explanation")}
						>
							詳解共筆
						</TabButton>
						<TabButton active={tab === "note"} onClick={() => setTab("note")}>
							個人筆記
							{data.my_note && (
								<span className="ml-1.5 text-[10px] text-ink-400 dark:text-ink-500">●</span>
							)}
						</TabButton>
						{/* Discussion tab — only appears in two-pane (lg+) view; on
						    mobile the 討論 section still lives at the bottom of the
						    right column (see `lg:hidden` on that section below). */}
						<TabButton
							active={tab === "discussion"}
							onClick={() => setTab("discussion")}
							className="hidden lg:inline-flex"
						>
							討論串
							<span className="ml-1.5 text-xs text-ink-400 dark:text-ink-500 font-sans">
								({commentCount})
							</span>
						</TabButton>
					</div>
					{tab === "explanation" && !editing && (
						<div className="flex items-center gap-3 flex-wrap justify-end">
							{hasExplanation && (
								<AiActionButton
									label="AI 摘要"
									loadingLabel="摘要中…"
									busy={aiLoading === "summary"}
									disabled={!!aiLoading && aiLoading !== "summary"}
									onClick={() => runAi("summary")}
									title="用 AI 產生 2-3 句重點摘要"
								/>
							)}
							{hasExplanation && (
								<AiActionButton
									label="AI 生成問答"
									loadingLabel="生成中…"
									busy={aiLoading === "qa"}
									disabled={!!aiLoading && aiLoading !== "qa"}
									onClick={() => runAi("qa")}
									title="依題幹與詳解產生高價值複習問答"
								/>
							)}
							{hasExplanation && (
								<AiActionButton
									label="AI 繁中翻譯"
									loadingLabel="翻譯中…"
									busy={aiLoading === "translate"}
									disabled={!!aiLoading && aiLoading !== "translate"}
									onClick={() => runAi("translate")}
									title="把目前詳解轉成台灣繁體用語"
								/>
							)}
							<a
								href={buildOpenEvidenceUrl(data)}
								target="_blank"
								rel="noopener noreferrer"
								className="text-sm text-ink-500 dark:text-ink-400 hover:text-accent inline-flex items-center gap-1"
								title="把題幹+選項丟到 OpenEvidence(不送正解,可當盲解參考)"
							>
								<ExternalLink size={14} /> OpenEvidence
							</a>
							<button
								onClick={startEdit}
								disabled={
									lockState.status === "acquiring" ||
									lockState.status === "locked-by-other"
								}
								className="text-sm text-accent hover:text-accent-dark disabled:opacity-40 inline-flex items-center gap-1"
							>
								{lockState.status === "locked-by-other" ? (
									<>{lockState.lockedBy} 正在編輯…</>
								) : (
									<>
										<Pencil size={14} /> 編輯
									</>
								)}
							</button>
						</div>
					)}
					{tab === "note" && !noteEditing && (
						<button
							onClick={startNoteEdit}
							className="text-sm text-accent hover:text-accent-dark inline-flex items-center gap-1"
						>
							<Pencil size={14} /> 編輯
						</button>
					)}
				</div>

				{tab === "explanation" &&
					(editing ? (
						<div className="bg-white dark:bg-ink-800 border-2 border-accent/40 rounded-lg p-4 sm:p-5 shadow-paper">
							<div className="mb-3 text-xs text-ink-500 dark:text-ink-400">
								{lockState.status === "held" && (
									<span>
										✓ 你正在編輯 · 鎖至{" "}
										{new Date(lockState.until).toLocaleTimeString("zh-TW")} ·
										目前版本 v{data.explanation?.version ?? 0}
									</span>
								)}
							</div>
							<RichEditor
								content={draft}
								onChange={setDraft}
								placeholder="輸入詳解。可貼上圖片、@提及他人,輸入 @114 引用題目。"
								autofocus
							/>
							{saveError && (
								<div className="mt-3 p-2 rounded bg-rose-50 dark:bg-rose-900/20 border border-rose-200 dark:border-rose-800 text-rose-800 dark:text-rose-300 text-sm">
									{saveError}
								</div>
							)}
							<div className="mt-4 flex gap-3 justify-end">
								<button
									onClick={cancelEdit}
									disabled={saving}
									className="px-4 py-2 text-sm text-ink-600 dark:text-ink-300 hover:text-ink-900 dark:hover:text-ink-100"
								>
									取消
								</button>
								<button
									onClick={save}
									disabled={saving}
									className="bg-accent hover:bg-accent-dark text-white px-5 py-2 rounded font-medium disabled:opacity-40"
								>
									{saving ? "儲存中…" : "儲存"}
								</button>
							</div>
						</div>
					) : hasExplanation ? (
						<>
							{(aiOutput || aiError) && (
								<AiPanel
									output={aiOutput}
									error={aiError}
									onClose={() => {
										setAiOutput(null);
										setAiError(null);
									}}
								/>
							)}
							<article className="bg-white dark:bg-ink-800 border border-ink-200 dark:border-ink-700 rounded-lg p-5 sm:p-7 shadow-paper">
								<div
									className={
										"relative " + (revealedExp ? "" : "min-h-[6rem]")
									}
								>
									<div
										className={
											"transition-[filter] duration-200 " +
											(revealedExp
												? ""
												: "blur-md select-none pointer-events-none")
										}
										aria-hidden={!revealedExp}
									>
										<ReadOnlyContent content={explanationJson} />
									</div>
									{!revealedExp && (
										<button
											type="button"
											onClick={() => setRevealedExp(true)}
											// appearance-none + bg-transparent + outline-none kill the
											// native button rectangle / focus outline that otherwise
											// shows behind the rounded pill on the inset-0 hit target.
											className="absolute inset-0 flex items-start justify-center pt-10 sm:pt-14 group appearance-none bg-transparent border-0 outline-none focus:outline-none focus-visible:outline-none"
											aria-label="顯示詳解"
											title="點擊顯示詳解(避免一進來就看到答案)"
										>
											{/* No box-shadow on the pill: shadow-paper's negative
											    spread can leave a visible rectangular fringe behind
											    a rounded-full element. The solid accent contrasts
											    enough against the blurred backdrop on its own. */}
											<span className="bg-accent group-hover:bg-accent-dark text-white px-4 py-2 rounded-full text-sm transition inline-flex items-center gap-1.5 ring-1 ring-accent-dark/20">
												<Eye size={14} /> 點擊顯示詳解
											</span>
										</button>
									)}
								</div>
								<footer className="mt-5 pt-3 border-t border-ink-100 dark:border-ink-700 text-xs text-ink-400 dark:text-ink-500">
									最近更新:{data.explanation?.updated_by ?? "—"}
									{data.explanation?.updated_at && (
										<>
											{" "}
											·{" "}
											{new Date(data.explanation.updated_at).toLocaleString(
												"zh-TW",
											)}
										</>
									)}
									· v{data.explanation?.version ?? 0}
								</footer>
							</article>
						</>
					) : (
						<>
							{(aiOutput || aiError) && (
								<AiPanel
									output={aiOutput}
									error={aiError}
									onClose={() => {
										setAiOutput(null);
										setAiError(null);
									}}
								/>
							)}
							<div className="bg-ink-50 dark:bg-ink-800/60 border border-dashed border-ink-200 dark:border-ink-700 rounded-lg p-8 text-center">
								<p className="text-ink-500 dark:text-ink-400 mb-3">
									尚無詳解,你願意第一個寫嗎?
								</p>
								<button
									onClick={startEdit}
									className="bg-accent hover:bg-accent-dark text-white px-5 py-2 rounded font-medium"
								>
									開始寫詳解
								</button>
							</div>
						</>
					))}

				{tab === "note" &&
					(noteEditing ? (
						<div className="bg-white dark:bg-ink-800 border-2 border-accent/40 rounded-lg p-4 sm:p-5 shadow-paper">
							<div className="mb-3 text-xs text-ink-500 dark:text-ink-400">
								✎ 個人筆記 · 僅你可見
							</div>
							<RichEditor
								content={noteDraft}
								onChange={setNoteDraft}
								placeholder="寫下你的私人筆記。可貼圖、@114 引用其他題目。"
								autofocus
							/>
							{noteError && (
								<div className="mt-3 p-2 rounded bg-rose-50 dark:bg-rose-900/20 border border-rose-200 dark:border-rose-800 text-rose-800 dark:text-rose-300 text-sm">
									{noteError}
								</div>
							)}
							<div className="mt-4 flex gap-3 justify-end">
								<button
									onClick={cancelNoteEdit}
									disabled={noteSaving}
									className="px-4 py-2 text-sm text-ink-600 dark:text-ink-300 hover:text-ink-900 dark:hover:text-ink-100"
								>
									取消
								</button>
								<button
									onClick={saveNote}
									disabled={noteSaving}
									className="bg-accent hover:bg-accent-dark text-white px-5 py-2 rounded font-medium disabled:opacity-40"
								>
									{noteSaving ? "儲存中…" : "儲存"}
								</button>
							</div>
						</div>
					) : noteJson ? (
						<article className="bg-white dark:bg-ink-800 border border-ink-200 dark:border-ink-700 rounded-lg p-5 sm:p-7 shadow-paper">
							<ReadOnlyContent content={noteJson} />
							<footer className="mt-5 pt-3 border-t border-ink-100 dark:border-ink-700 text-xs text-ink-400 dark:text-ink-500">
								僅你可見
								{data.my_note?.updated_at && (
									<>
										{" "}
										· 最近編輯{" "}
										{new Date(data.my_note.updated_at).toLocaleString("zh-TW")}
									</>
								)}
							</footer>
						</article>
					) : (
						<div className="bg-ink-50 dark:bg-ink-800/60 border border-dashed border-ink-200 dark:border-ink-700 rounded-lg p-8 text-center">
							<p className="text-ink-500 dark:text-ink-400 mb-3">
								尚未寫下個人筆記。這裡僅你可見。
							</p>
							<button
								onClick={startNoteEdit}
								className="bg-accent hover:bg-accent-dark text-white px-5 py-2 rounded font-medium"
							>
								開始寫筆記
							</button>
						</div>
					))}

				{/* Discussion tab panel — lg-only. On mobile the discussion lives
				    in its own section at the bottom (Comments below). The effect
				    above forces tab back to "explanation" if the viewport drops
				    below lg while this tab is active, so we never land in a state
				    where the tab is set to "discussion" but invisible. */}
				{tab === "discussion" && (
					<div className="hidden lg:block mt-2">
						{me ? (
							<CommentThread
								questionId={data.id}
								currentEmail={me.email}
								onCountChange={setCommentCount}
							/>
						) : (
							<p className="text-ink-400 dark:text-ink-500 text-sm">
								載入使用者…
							</p>
						)}
					</div>
				)}
			</section>

			{/* 相似題目 — tag-overlap with BM25 fallback, hidden when empty */}
			{similar.length > 0 && (
				<section className="mt-8">
					<h2 className="font-serif text-lg text-ink-800 dark:text-ink-100 mb-3">相似題目</h2>
					<ul className="space-y-1.5">
						{similar.map((s) => (
							<li
								key={s.id}
								className="bg-white dark:bg-ink-800 border border-ink-200 dark:border-ink-700 rounded p-3 flex items-start gap-3 hover:border-accent transition"
							>
								<Link
									to={`/q/${s.id}`}
									className="flex-1 flex items-start gap-3 min-w-0"
								>
									<span className="font-mono text-sm text-ink-500 dark:text-ink-400 shrink-0">
										{s.year}-{String(s.number).padStart(3, "0")}
									</span>
									<BookmarkBadge questionId={s.id} className="mt-1" />
									<span className="text-ink-700 dark:text-ink-200 line-clamp-1 flex-1">
										{s.stem}
									</span>
								</Link>
								<span
									className={
										"text-[11px] px-2 py-0.5 rounded shrink-0 self-center " +
										(s.source === "tag"
											? "bg-emerald-50 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300"
											: "bg-ink-100 text-ink-600 dark:bg-ink-700 dark:text-ink-300")
									}
									title={s.source === "tag" ? "共用標籤數" : "文字相似 (BM25)"}
								>
									{s.source === "tag"
										? `共 ${s.shared_tags} 個 tag`
										: "文字相似"}
								</span>
							</li>
						))}
					</ul>
				</section>
			)}

			{/* Back-references — appears only when other questions/comments cite this one */}
			{data.back_refs.length > 0 && (
				<section className="mt-10">
					<h2 className="font-serif text-lg text-ink-800 dark:text-ink-100 mb-3 inline-flex items-center gap-2">
						<LinkIcon size={16} className="text-ink-400 dark:text-ink-500" /> 被引用 (
						{data.back_refs.length})
					</h2>
					<ul className="space-y-1.5">
						{data.back_refs.map((r) => (
							<li
								key={`${r.source_type}:${r.source_question_id}:${r.created_at}`}
								className="bg-white dark:bg-ink-800 border border-ink-200 dark:border-ink-700 rounded p-3 flex items-start gap-3 hover:border-accent transition"
							>
								<Link
									to={`/q/${r.source_question_id}`}
									className="flex-1 flex items-start gap-3 min-w-0"
								>
									<span className="font-mono text-sm text-ink-500 dark:text-ink-400 shrink-0">
										{r.source_question_id}
									</span>
									<BookmarkBadge
										questionId={r.source_question_id}
										className="mt-1"
									/>
									<span className="text-ink-700 dark:text-ink-200 line-clamp-1 flex-1">
										{r.source_stem}
									</span>
								</Link>
								<span className="text-xs text-ink-400 dark:text-ink-500 shrink-0 self-center">
									{r.source_type === "comment" ? "留言" : "詳解"} ·{" "}
									{r.by_email.split("@")[0]}
								</span>
							</li>
						))}
					</ul>
				</section>
			)}

			{/* Comments — mobile only. At lg+ this content is shown inside the
			    詳解共筆 / 個人筆記 / 討論串 tab strip above (the 討論串 tab is
			    `hidden lg:inline-flex`), so we hide this bottom section there to
			    avoid rendering CommentThread twice and double-fetching. */}
			<section className="mt-12 lg:hidden">
				<h2 className="font-serif text-xl text-ink-800 dark:text-ink-100 mb-3">討論</h2>
				{me ? (
					<CommentThread
						questionId={data.id}
						currentEmail={me.email}
						onCountChange={setCommentCount}
					/>
				) : (
					<p className="text-ink-400 dark:text-ink-500 text-sm">載入使用者…</p>
				)}
			</section>
			</div>{/* /right column */}
			</div>{/* /two-column grid */}
		</div>
	);
}

function AiActionButton({
	label,
	loadingLabel,
	busy,
	disabled,
	onClick,
	title,
}: {
	label: string;
	loadingLabel: string;
	busy: boolean;
	disabled: boolean;
	onClick: () => void;
	title: string;
}) {
	return (
		<button
			onClick={onClick}
			disabled={busy || disabled}
			className="text-sm text-ink-500 dark:text-ink-400 hover:text-accent disabled:opacity-40 inline-flex items-center gap-1"
			title={title}
		>
			<Sparkles size={14} />
			{busy ? loadingLabel : label}
		</button>
	);
}

const AI_PANEL_HEADINGS: Record<AiKind, string> = {
	summary: "AI 摘要 · 僅供快速回顧",
	translate: "AI 繁中翻譯 · 機器轉換,請核對",
	qa: "AI 生成問答 · 請核對後使用",
};

function AiPanel({
	output,
	error,
	onClose,
}: {
	output: AiOutput | null;
	error: { kind: AiKind; message: string } | null;
	onClose: () => void;
}) {
	const kind = output?.kind ?? error?.kind ?? "summary";
	return (
		<aside className="mb-3 bg-amber-50/60 dark:bg-amber-900/10 border border-amber-200/70 dark:border-amber-800/40 rounded-lg p-4 text-sm">
			<div className="flex items-start justify-between gap-3 mb-1">
				<span className="inline-flex items-center gap-1 text-xs text-amber-800 dark:text-amber-300 font-medium tracking-wide">
					<Sparkles size={12} /> {AI_PANEL_HEADINGS[kind]}
				</span>
				<button
					onClick={onClose}
					className="text-ink-400 dark:text-ink-500 hover:text-ink-600 dark:hover:text-ink-300"
					aria-label="關閉 AI 面板"
				>
					<XIcon size={14} />
				</button>
			</div>
			{error ? (
				<p className="text-rose-700">{error.message}</p>
			) : output?.kind === "qa" ? (
				<ol className="mt-3 space-y-4">
					{output.items.map((item, index) => (
						<li
							key={`${item.question}-${index}`}
							className="grid grid-cols-[1.75rem_1fr] gap-3 border-t border-amber-200/60 dark:border-amber-800/40 pt-4 first:border-t-0 first:pt-0"
						>
							<span className="font-semibold tabular-nums text-ink-900 dark:text-ink-100">
								{index + 1}.
							</span>
							<div className="min-w-0">
								<h3 className="font-semibold leading-snug text-ink-900 dark:text-ink-100">
									{item.question}
								</h3>
								<ul className="mt-2 space-y-1.5">
									{item.answer.map((line, answerIndex) => (
										<li
											key={`${line}-${answerIndex}`}
											className="grid grid-cols-[0.65rem_1fr] gap-2 leading-relaxed text-ink-800 dark:text-ink-200"
										>
											<span className="mt-[0.65em] h-1.5 w-1.5 rounded-full bg-ink-500 dark:bg-ink-400" />
											<span>{line}</span>
										</li>
									))}
								</ul>
							</div>
						</li>
					))}
				</ol>
			) : output ? (
				<p className="text-ink-800 dark:text-ink-200 whitespace-pre-wrap leading-relaxed">
					{output.text}
				</p>
			) : null}
		</aside>
	);
}

// Flatten a TipTap doc to plain text — paragraphs joined by \n\n, headings prefixed
// with #, list items with • / 1. We strip image and mention nodes; the AI doesn't
// need them for these prompts and they only inflate the request.
function tiptapToText(doc: any): string {
	const parts: string[] = [];
	function walkInline(node: any): string {
		if (!node) return "";
		if (node.type === "text") return node.text || "";
		if (node.type === "mention")
			return `@${node.attrs?.label || node.attrs?.id || ""}`;
		if (node.type === "hardBreak") return "\n";
		if (Array.isArray(node.content))
			return node.content.map(walkInline).join("");
		return "";
	}
	function walkBlock(node: any) {
		if (!node || !node.type) return;
		if (node.type === "paragraph" || node.type === "blockquote") {
			const t = (node.content || []).map(walkInline).join("").trim();
			if (t) parts.push(t);
			return;
		}
		if (node.type === "heading") {
			const t = (node.content || []).map(walkInline).join("").trim();
			const level = node.attrs?.level ?? 1;
			if (t) parts.push("#".repeat(level) + " " + t);
			return;
		}
		if (node.type === "bulletList" || node.type === "orderedList") {
			const ordered = node.type === "orderedList";
			(node.content || []).forEach((li: any, i: number) => {
				const t = (li.content || [])
					.map((c: any) => walkInline(c))
					.join("")
					.trim();
				if (t) parts.push((ordered ? `${i + 1}. ` : "• ") + t);
			});
			return;
		}
		if (Array.isArray(node.content)) node.content.forEach(walkBlock);
	}
	walkBlock(doc);
	return parts.join("\n\n").slice(0, 4000);
}

function TabButton({
	active,
	onClick,
	children,
	className = "",
}: {
	active: boolean;
	onClick: () => void;
	children: React.ReactNode;
	// Caller-supplied responsive classes (e.g. "hidden lg:inline-flex") for
	// tabs that should only appear at certain breakpoints. Appended to the
	// base styling rather than replacing it.
	className?: string;
}) {
	return (
		<button
			onClick={onClick}
			className={
				"px-4 py-2 -mb-px border-b-2 font-serif text-base transition " +
				(active
					? "border-accent text-ink-900 dark:text-ink-100"
					: "border-transparent text-ink-500 hover:text-ink-700 dark:hover:text-ink-300") +
				(className ? " " + className : "")
			}
		>
			{children}
		</button>
	);
}

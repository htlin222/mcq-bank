import {
	useEffect,
	useState,
	useMemo,
	useRef,
	useCallback,
	type CSSProperties,
} from "react";
import { useParams, Link, useNavigate, useLocation } from "react-router-dom";
import {
	AppWindow,
	ChevronLeft,
	ChevronRight,
	Columns2,
	CornerLeftUp,
	Pencil,
	LinkIcon,
	Search as SearchIcon,
	Eye,
	ExternalLink,
	GripVertical,
	Videotape,
	Sparkles,
	RefreshCcw,
} from "lucide-react";
import { api, ApiError } from "../lib/api";
import { loadDraft, saveDraft, clearDraft } from "../lib/drafts";
import { noteTitleFromJson } from "../lib/noteTitle";
import { NoteSwitcher, type NoteMeta } from "../components/NoteSwitcher";
import { buildOpenEvidenceUrl } from "../lib/openevidence";
import { useQuestion } from "../hooks/useQuestion";
import { useLock } from "../hooks/useLock";
import { useMe } from "../hooks/useMe";
import { useOnline } from "../hooks/useOnline";
import { QuestionCard } from "../components/QuestionCard";
import { RichEditor } from "../components/RichEditor";
import { AnnotatableContent } from "../components/AnnotatableContent";
import { NoteContent } from "../components/NoteContent";
import { CommentThread } from "../components/CommentThread";
import { BookmarkBadge } from "../components/BookmarkBadge";
import { QuestionDetailSkeleton } from "../components/Skeleton";
import { searchNeighbors } from "../lib/searchCache";
import { rememberAutoCloze, wasAutoCloze } from "../lib/clozePref";
import {
	VideoTopicSection,
	type VideoTopicGroup,
} from "../components/VideoList";

// Resizable two-pane split (≥md). `splitPct` is the left pane's share of the
// row width; the rest goes to the right pane. Persisted as a UI layout pref.
const SPLIT_MIN = 28;
const SPLIT_MAX = 72;
const SPLIT_DEFAULT = 42; // ≈ the previous fixed 5fr / 7fr ratio
const SPLIT_KEY = "review-split-pct";

function clampSplit(p: number) {
	return Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, p));
}

// Desktop (≥md) view mode: side-by-side columns vs. a single full-width tab
// strip (題目/詳解/個人筆記/討論串/相似題目). Below md the page is always a
// single stacked column, so this — and the header toggle + `t` shortcut —
// only affect large screens.
type LayoutMode = "columns" | "tabs";
const LAYOUT_KEY = "review-layout-mode";
type MainTab =
	| "question"
	| "explanation"
	| "note"
	| "discussion"
	| "similar"
	| "video";

type Tab = "explanation" | "note" | "discussion" | "similar" | "video";

// Why 自動挖空 came back empty, in the reader's words.
const AUTO_CLOZE_REASON: Record<string, string> = {
	no_content: "這裡還沒有內容可以挖空",
	too_short: "內容太短,挖空起來沒意義",
	ai_empty: "AI 這次挑不出關鍵詞,可以再按一次",
};

// 防劇透 / 自動挖空 toggles in the 詳解 and 個人筆記 toolbars — same look in both.
const TOOL_BTN = (on: boolean) =>
	"inline-flex items-center gap-1 rounded px-2 py-1 text-sm transition disabled:opacity-50 " +
	(on
		? "bg-accent text-white"
		: "text-ink-500 dark:text-ink-400 hover:text-accent hover:bg-accent/10");

type SimilarItem = {
	id: string;
	year: number;
	number: number;
	stem: string;
	group: string | null;
	shared_tags: number;
	source: "vec" | "tag" | "fts";
};

type NoteLink = {
	targetKind: "note" | "question";
	targetId: string;
	year: number;
	number: number;
	stem: string;
	group: string | null;
	sharedTerms: string[];
};

export function Question() {
	const { id } = useParams<{ id: string }>();
	const { me } = useMe();
	const { data, error, reload } = useQuestion(id);
	const { state: lockState, acquire, release } = useLock(id || "");
	// 詳解 is behind a pessimistic server lock — attempting to edit offline can
	// only ever fail, and would strand a draft against a lock we never held.
	const online = useOnline();

	const [tab, setTab] = useState<Tab>("explanation");

	// Desktop layout mode (columns vs. tabs). Persisted as a UI layout pref.
	const [layout, setLayout] = useState<LayoutMode>(() => {
		const raw =
			typeof localStorage !== "undefined"
				? localStorage.getItem(LAYOUT_KEY)
				: null;
		return raw === "tabs" ? "tabs" : "columns";
	});
	// Which pane is visible in tabs mode (≥md only).
	const [mainTab, setMainTab] = useState<MainTab>("question");
	const tabsMode = layout === "tabs";

	// The inner 詳解共筆/… tab strip is sticky (see below); its measured height
	// drives where the sticky per-pane toolbar (自動挖空/防劇透/編輯) pins, so the
	// two stack flush instead of overlapping or leaving a gap. Only the columns
	// layout stacks them — tabs mode scrolls the page normally.
	const innerStripRef = useRef<HTMLDivElement>(null);
	const [stripH, setStripH] = useState(0);
	useEffect(() => {
		const el = innerStripRef.current;
		if (!el) return;
		const update = () => setStripH(el.offsetHeight);
		update();
		const ro = new ResizeObserver(update);
		ro.observe(el);
		return () => ro.disconnect();
		// `data` is a dep because the strip only mounts once the question loads
		// (the component returns a skeleton while `!data`), so the ref is null on
		// the first run and we must re-attach the observer once it exists.
	}, [tabsMode, data]);

	useEffect(() => {
		try {
			localStorage.setItem(LAYOUT_KEY, layout);
		} catch {
			/* ignore quota/availability errors */
		}
	}, [layout]);

	// The top strip in tabs mode replaces the inner 詳解共筆/個人筆記/討論串
	// strip at ≥md (it stays for the stacked <lg layout). Keep the inner `tab`
	// state following the top-level selection so the shared content blocks and
	// their action buttons (編輯 etc.) render the right panel.
	useEffect(() => {
		if (!tabsMode) return;
		if (
			mainTab === "explanation" ||
			mainTab === "note" ||
			mainTab === "discussion"
		) {
			setTab(mainTab);
		}
	}, [tabsMode, mainTab]);

	// `t` toggles columns ⇄ tabs. Same guards as QuestionCard's A–E shortcut:
	// skip when typing in an input / textarea / contenteditable (TipTap) or
	// holding a modifier. lg-only, matching the toggle button's visibility.
	useEffect(() => {
		function onKeyDown(e: KeyboardEvent) {
			if (e.metaKey || e.ctrlKey || e.altKey) return;
			if (e.key !== "t" && e.key !== "T") return;
			const el = e.target as HTMLElement | null;
			if (
				el &&
				(el.tagName === "INPUT" ||
					el.tagName === "TEXTAREA" ||
					el.tagName === "SELECT" ||
					el.isContentEditable)
			)
				return;
			if (!window.matchMedia("(min-width: 768px)").matches) return;
			setLayout((l) => (l === "columns" ? "tabs" : "columns"));
		}
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, []);

	// Desktop two-pane split ratio (left pane %). Persisted as a UI layout pref.
	const splitRowRef = useRef<HTMLDivElement>(null);
	const [splitPct, setSplitPct] = useState<number>(() => {
		const raw =
			typeof localStorage !== "undefined"
				? localStorage.getItem(SPLIT_KEY)
				: null;
		const n = raw ? Number(raw) : NaN;
		return Number.isFinite(n) ? clampSplit(n) : SPLIT_DEFAULT;
	});

	useEffect(() => {
		try {
			localStorage.setItem(SPLIT_KEY, String(splitPct));
		} catch {
			/* ignore quota/availability errors */
		}
	}, [splitPct]);

	// Drag the middle handle to repan the split. We map the pointer's x within
	// the row to a left-pane percentage so the divide tracks the cursor exactly.
	const onSplitResizeStart = useCallback(
		(e: React.PointerEvent<HTMLDivElement>) => {
			e.preventDefault();
			const row = splitRowRef.current;
			if (!row) return;
			const handle = e.currentTarget;
			handle.setPointerCapture(e.pointerId);
			document.body.style.userSelect = "none";
			document.body.style.cursor = "col-resize";

			const onMove = (ev: PointerEvent) => {
				const rect = row.getBoundingClientRect();
				if (rect.width === 0) return;
				const pct = ((ev.clientX - rect.left) / rect.width) * 100;
				setSplitPct(clampSplit(pct));
			};
			const onUp = (ev: PointerEvent) => {
				handle.releasePointerCapture?.(ev.pointerId);
				handle.removeEventListener("pointermove", onMove);
				handle.removeEventListener("pointerup", onUp);
				handle.removeEventListener("pointercancel", onUp);
				document.body.style.userSelect = "";
				document.body.style.cursor = "";
			};
			handle.addEventListener("pointermove", onMove);
			handle.addEventListener("pointerup", onUp);
			handle.addEventListener("pointercancel", onUp);
		},
		[],
	);

	// Double-click the handle to reset the split to the default ratio.
	const onSplitResetSplit = useCallback(() => setSplitPct(SPLIT_DEFAULT), []);

	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState<any>(null);
	const [saving, setSaving] = useState(false);
	const [saveError, setSaveError] = useState<string | null>(null);
	// 詳解 spoiler guard — start blurred on every question so users don't see
	// the answer before attempting. CSS-only blur on the already-rendered
	// ReadOnlyContent, so no extra render pass and no content duplication.
	const [revealedExp, setRevealedExp] = useState(false);
	// 一題可以有多則筆記,slot 是它們的編號(migration 0036)。my_notes 是新
	// 欄位:離線快取裡可能還是舊 payload,那就把 my_note 當成唯一的第 0 則。
	const notes = useMemo<NoteMeta[]>(() => {
		if (data?.my_notes?.length) return data.my_notes;
		if (data?.my_note) {
			return [
				{
					slot: 0,
					content_json: data.my_note.content_json,
					created_at: data.my_note.updated_at,
					updated_at: data.my_note.updated_at,
				},
			];
		}
		return [];
	}, [data?.my_notes, data?.my_note]);

	const [noteSlot, setNoteSlot] = useState(0);
	const [notesBusy, setNotesBusy] = useState(false);
	// 換題目時回到第一則。activeNote 的 fallback 也接住「目前這則剛被刪掉」:
	// 少了它,面板會顯示「尚未寫下個人筆記」,而其他幾則其實還在。
	useEffect(() => {
		setNoteSlot(0);
	}, [data?.id]);
	const activeNote = notes.find((n) => n.slot === noteSlot) ?? notes[0] ?? null;
	const activeSlot = activeNote?.slot ?? 0;

	// 防劇透 and 自動挖空 are two independent switches over the same reader:
	//   防劇透 = 遮 / 不遮 (covers 個人畫記 + whatever the AI layer contributes)
	//   自動挖空 = AI 關鍵詞這層在不在 (press again to take it away)
	// Both are per section (詳解 / 個人筆記) and reset when switching questions.
	// The AI terms are never written into 個人畫記 — they are a separate,
	// server-cached list handed to the renderer as a decoration layer.
	const [expCloze, setExpCloze] = useState(false);
	const [noteCloze, setNoteCloze] = useState(false);
	const [autoClozeTerms, setAutoClozeTerms] = useState<string[] | null>(null);
	const [autoClozeLoading, setAutoClozeLoading] = useState(false);
	const [autoClozeMsg, setAutoClozeMsg] = useState<string | null>(null);
	const [noteAutoTerms, setNoteAutoTerms] = useState<string[] | null>(null);
	const [noteAutoLoading, setNoteAutoLoading] = useState(false);
	const [noteAutoMsg, setNoteAutoMsg] = useState<string | null>(null);
	useEffect(() => {
		setExpCloze(false);
		setNoteCloze(false);
		setAutoClozeTerms(null);
		setNoteAutoTerms(null);
		setAutoClozeMsg(null);
		setNoteAutoMsg(null);
	}, [data?.id]);

	// Bring back the blanks this reader had up last time. `cached_only=1` means
	// a reload never silently spends Workers AI: if the cache expired (the text
	// changed, or the prompt version moved on) the section simply comes back
	// un-blanked and the button is there to press.
	useEffect(() => {
		const qid = data?.id;
		if (!qid) return;
		let cancelled = false;
		for (const source of ["explanation", "note"] as const) {
			if (!wasAutoCloze(qid, source)) continue;
			// 挖空是逐則的(每則筆記有自己的關鍵詞快取),所以帶上目前這則。
			const qs =
				source === "note"
					? `?source=note&slot=${activeSlot}&cached_only=1`
					: "?cached_only=1";
			api
				.get<{ terms: string[] }>(`/api/questions/${qid}/auto-cloze${qs}`)
				.then((r) => {
					if (cancelled || !r.terms?.length) return;
					if (source === "note") {
						setNoteAutoTerms(r.terms);
						setNoteCloze(true);
					} else {
						setAutoClozeTerms(r.terms);
						setExpCloze(true);
					}
				})
				.catch(() => {
					/* offline or gone — leave the section un-blanked */
				});
		}
		return () => {
			cancelled = true;
		};
	}, [data?.id, activeSlot]);

	// 換筆記等於換一份文本:上一則挑出來的關鍵詞對這一則沒有意義,先清掉,
	// 上面那個 effect 會再去問這一則有沒有現成的快取。
	useEffect(() => {
		setNoteAutoTerms(null);
		setNoteCloze(false);
		setNoteAutoMsg(null);
	}, [activeSlot]);

	// Toggle the AI layer for a section. Pressing it while it is on removes it
	// outright (no reload needed); pressing it while off fetches the terms —
	// cached server-side, so a repeat press costs nothing — and, as a
	// convenience, turns 防劇透 on so the blanks are actually covered.
	async function toggleAutoCloze(qid: string, target: "exp" | "note") {
		const on = target === "exp" ? autoClozeTerms : noteAutoTerms;
		const setTerms = target === "exp" ? setAutoClozeTerms : setNoteAutoTerms;
		const setLoading =
			target === "exp" ? setAutoClozeLoading : setNoteAutoLoading;
		const setMsg = target === "exp" ? setAutoClozeMsg : setNoteAutoMsg;
		const setCloze = target === "exp" ? setExpCloze : setNoteCloze;
		const loading = target === "exp" ? autoClozeLoading : noteAutoLoading;
		if (loading) return;
		if (on && on.length > 0) {
			setTerms(null);
			setMsg(null);
			rememberAutoCloze(qid, target === "note" ? "note" : "explanation", false);
			return;
		}
		setLoading(true);
		setMsg(null);
		try {
			const r = await api.get<{ terms: string[]; reason?: string }>(
				`/api/questions/${qid}/auto-cloze${
					target === "note" ? `?source=note&slot=${activeSlot}` : ""
				}`,
			);
			if (r.terms.length === 0) {
				setTerms(null);
				setMsg(
					AUTO_CLOZE_REASON[r.reason ?? ""] ?? "這次挑不出關鍵詞,請再試一次",
				);
				return;
			}
			setTerms(r.terms);
			setCloze(true);
			rememberAutoCloze(qid, target === "note" ? "note" : "explanation", true);
		} catch {
			setTerms(null);
			setMsg("自動挖空失敗,請稍後再試");
		} finally {
			setLoading(false);
		}
	}
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

	const explanationJson = useMemo(() => {
		if (!data?.explanation?.content_json) return null;
		try {
			return JSON.parse(data.explanation.content_json);
		} catch {
			return null;
		}
	}, [data?.explanation?.content_json]);

	const noteJson = useMemo(() => {
		if (!activeNote?.content_json) return null;
		try {
			return JSON.parse(activeNote.content_json);
		} catch {
			return null;
		}
	}, [activeNote?.content_json]);

	// Re-blur the 詳解 whenever the user navigates to a different question
	// (prev/next, similar, back-refs, deep link). Same component instance, so
	// useState alone wouldn't reset.
	useEffect(() => {
		setRevealedExp(false);
	}, [data?.id]);

	// In tabs mode, land on 題目 for every new question — arriving on 詳解區
	// after prev/next would spoil the answer before the user attempts it.
	useEffect(() => {
		setMainTab("question");
	}, [data?.id]);

	// Seed/refresh the comment-count badge from the question payload. Kept in
	// sync via onCountChange when CommentThread is mounted.
	useEffect(() => {
		if (typeof data?.comment_count === "number") {
			setCommentCount(data.comment_count);
		}
	}, [data?.id, data?.comment_count]);

	// If the user is on a columns-only inner tab (討論串 / 相似題目, both hidden
	// below md) and the viewport shrinks below md, snap them back to the
	// explanation tab so they aren't stuck on an invisible tab with no content.
	useEffect(() => {
		if (tab !== "discussion" && tab !== "similar") return;
		const mq = window.matchMedia("(min-width: 768px)");
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

	// 策展影片 — 走 question_tags → tag_topics → topic_videos,依主題分組。
	// 跟 similar 一樣延後載入:多數人開題目是為了看詳解,不該讓影片擋路。
	const [videoTopics, setVideoTopics] = useState<VideoTopicGroup[]>([]);
	useEffect(() => {
		if (!data?.id) return;
		let cancelled = false;
		api
			.get<{ topics: VideoTopicGroup[] }>(`/api/questions/${data.id}/videos`)
			.then((r) => {
				if (!cancelled) setVideoTopics(r.topics ?? []);
			})
			.catch(() => {
				if (!cancelled) setVideoTopics([]);
			});
		return () => {
			cancelled = true;
		};
	}, [data?.id]);

	const videoCount = videoTopics.reduce((n, t) => n + t.videos.length, 0);
	const hasVideos = videoCount > 0;

	// 影片 tab 只在有影片時渲染。切到下一題若沒影片,別把人留在一個
	// 已經不存在的 tab 上盯著空白。
	useEffect(() => {
		if (hasVideos) return;
		setTab((t) => (t === "video" ? "explanation" : t));
		setMainTab((t) => (t === "video" ? "explanation" : t));
	}, [hasVideos]);

	// 移除是全域的,所以本地也要從每個主題裡拿掉,不能只改當前這組。
	function dropVideo(id: string) {
		setVideoTopics((groups) =>
			groups
				.map((g) => ({ ...g, videos: g.videos.filter((v) => v.id !== id) }))
				.filter((g) => g.videos.length > 0),
		);
	}

	// 你可能想連結 — 依筆記命中的受控關鍵字建議相關題目 / 你自己的其他筆記。
	// 伺服端惰性計算(零 Workers AI 神經元)。僅在有筆記時抓;存檔後
	// (updated_at 變) 會重抓,伺服端會重算。
	const [noteLinks, setNoteLinks] = useState<NoteLink[]>([]);
	useEffect(() => {
		if (!data?.id || !data.my_note) {
			setNoteLinks([]);
			return;
		}
		let cancelled = false;
		api
			.get<{ links: NoteLink[] }>(`/api/questions/${data.id}/note/links`)
			.then((r) => {
				if (!cancelled) setNoteLinks(r.links ?? []);
			})
			.catch(() => {
				if (!cancelled) setNoteLinks([]);
			});
		return () => {
			cancelled = true;
		};
	}, [data?.id, data?.my_note?.updated_at]);

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

	// When arriving from 搜尋 and the result set is still cached, prev/next walk
	// the *search result* order (across years) rather than same-year neighbours.
	// Cache miss (stale / reloaded) → null → we fall back to `neighbors` and the
	// plain 上一題/下一題 labels. Read during render — it's a cheap pure lookup.
	const searchNav =
		data && fromSearch ? searchNeighbors(fromSearch, data.id) : null;
	const inSearchNav = searchNav !== null;
	const navPrev = searchNav ? (searchNav.prev ?? undefined) : neighbors.prev;
	const navNext = searchNav ? (searchNav.next ?? undefined) : neighbors.next;

	// Half-finished edits survive route switches (sessionStorage). The 詳解
	// key is scoped to the version being edited, so a draft goes stale (and is
	// ignored) as soon as someone else saves a newer version.
	const expDraftKey = data
		? `exp:${data.id}:v${data.explanation?.version ?? 0}`
		: "";
	// 第 0 則沿用原本的 key —— 換了 key 等於把使用者手上那份未送出的草稿丟掉。
	const noteDraftKey = data
		? activeSlot === 0
			? `note:${data.id}`
			: `note:${data.id}:${activeSlot}`
		: "";

	// Surface a "you have an unsaved draft" hint when returning to the page,
	// otherwise the restore-on-編輯 behaviour is invisible.
	const hasExpDraft = useMemo(
		() => !editing && !!expDraftKey && loadDraft(expDraftKey) !== null,
		[expDraftKey, editing],
	);
	const hasNoteDraft = useMemo(
		() => !noteEditing && !!noteDraftKey && loadDraft(noteDraftKey) !== null,
		[noteDraftKey, noteEditing],
	);

	async function startEdit() {
		if (!data) return;
		const ok = await acquire();
		if (!ok) return;
		setDraft(
			loadDraft(expDraftKey) ??
				explanationJson ?? { type: "doc", content: [{ type: "paragraph" }] },
		);
		setEditing(true);
		setSaveError(null);
	}

	async function cancelEdit() {
		clearDraft(expDraftKey);
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
			clearDraft(expDraftKey);
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
		setNoteDraft(
			loadDraft(noteDraftKey) ??
				noteJson ?? { type: "doc", content: [{ type: "paragraph" }] },
		);
		setNoteEditing(true);
		setNoteError(null);
	}

	function cancelNoteEdit() {
		clearDraft(noteDraftKey);
		setNoteEditing(false);
		setNoteDraft(null);
		setNoteError(null);
	}

	async function saveNote() {
		if (!data || noteSaving) return;
		setNoteSaving(true);
		setNoteError(null);
		try {
			await api.put(`/api/questions/${data.id}/note`, {
				content_json: noteDraft,
				slot: activeSlot,
			});
			clearDraft(noteDraftKey);
			// 先等新資料回來再收編輯器 —— 反過來的話,中間那一瞬間會用舊資料
			// 畫唯讀畫面,切換器上的名字閃一下「未命名筆記」才變成剛打的第一行。
			await reload();
			setNoteEditing(false);
			setNoteDraft(null);
		} catch (e) {
			setNoteError(String(e));
		} finally {
			setNoteSaving(false);
		}
	}

	// 新增一則:伺服器決定 slot(不重用被刪掉的號碼),回來直接切過去並開編輯器
	// —— 新筆記是空的,停在唯讀畫面上沒有任何意義。
	async function addNote() {
		if (!data || notesBusy) return;
		setNotesBusy(true);
		setNoteError(null);
		try {
			const r = await api.post<{ slot: number }>(
				`/api/questions/${data.id}/notes`,
			);
			await reload();
			setNoteSlot(r.slot);
			setNoteDraft({ type: "doc", content: [{ type: "paragraph" }] });
			setNoteEditing(true);
		} catch (e) {
			setNoteError(
				e instanceof ApiError && e.status === 409
					? "這一題的筆記數量已達上限。"
					: String(e),
			);
		} finally {
			setNotesBusy(false);
		}
	}

	async function removeNote(slot: number) {
		if (!data || notesBusy) return;
		const target = notes.find((n) => n.slot === slot);
		const label = target ? noteTitleFromJson(target.content_json) : "這則筆記";
		if (!confirm(`刪除「${label}」?這個動作沒有復原。`)) return;
		setNotesBusy(true);
		setNoteError(null);
		try {
			await api.del(
				`/api/questions/${data.id}/note?slot=${encodeURIComponent(slot)}`,
			);
			clearDraft(slot === 0 ? `note:${data.id}` : `note:${data.id}:${slot}`);
			if (noteEditing && slot === activeSlot) {
				setNoteEditing(false);
				setNoteDraft(null);
			}
			// 刪掉的可能就是目前這則 —— 先落到第一則,reload 後再由 activeNote
			// 的 fallback 收尾。
			setNoteSlot(0);
			await reload();
		} catch (e) {
			setNoteError(String(e));
		} finally {
			setNotesBusy(false);
		}
	}

	// Review-mode page shortcuts. Answer selection / submit / copy / bookmark
	// live in QuestionCard; here: ← 上一題, → 下一題, ↑ 回年度列表, h/l cycle the
	// tab strip (5 tabs in tabs mode; the right-column tabs otherwise), n jumps
	// to 個人筆記 and opens its editor. A ref keeps the handler fresh without
	// re-binding; skipped while typing or editing.
	const pageShortcutRef = useRef<(e: KeyboardEvent) => void>(() => {});
	pageShortcutRef.current = (e: KeyboardEvent) => {
		if (e.metaKey || e.ctrlKey || e.altKey) return;
		const el = e.target as HTMLElement | null;
		if (
			el &&
			(el.tagName === "INPUT" ||
				el.tagName === "TEXTAREA" ||
				el.tagName === "SELECT" ||
				el.isContentEditable)
		)
			return;
		if (!data || editing || noteEditing) return;
		const md = window.matchMedia("(min-width: 768px)").matches;

		if (e.key === "ArrowLeft") {
			if (navPrev) {
				e.preventDefault();
				navigate(`/q/${navPrev}`, { state: location.state });
			}
			return;
		}
		if (e.key === "ArrowRight") {
			if (navNext) {
				e.preventDefault();
				navigate(`/q/${navNext}`, { state: location.state });
			}
			return;
		}
		if (e.key === "ArrowUp") {
			e.preventDefault();
			navigate(`/year/${data.year}`);
			return;
		}

		const k = e.key.toLowerCase();
		if (k === "h" || k === "l") {
			e.preventDefault();
			const dir = k === "l" ? 1 : -1;
			if (md && tabsMode) {
				// 影片 tab 只在有影片時存在,循環順序也要跟著少一格。
				const order: MainTab[] = [
					"question",
					"explanation",
					"note",
					"discussion",
					"similar",
					...(hasVideos ? (["video"] as MainTab[]) : []),
				];
				setMainTab(
					(cur) =>
						order[(order.indexOf(cur) + dir + order.length) % order.length],
				);
			} else {
				const order: Tab[] = md
					? [
							"explanation",
							"note",
							"discussion",
							"similar",
							...(hasVideos ? (["video"] as Tab[]) : []),
						]
					: ["explanation", "note", ...(hasVideos ? (["video"] as Tab[]) : [])];
				const i = order.indexOf(tab);
				const base = i < 0 ? 0 : i;
				setTab(order[(base + dir + order.length) % order.length]);
			}
			return;
		}
		if (k === "n") {
			e.preventDefault();
			setTab("note");
			setMainTab("note");
			if (!noteEditing) startNoteEdit();
			return;
		}
	};
	useEffect(() => {
		const onKeyDown = (e: KeyboardEvent) => pageShortcutRef.current(e);
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, []);

	// While we have data, keep rendering even during a refetch — this is the
	// common case after saving 詳解, where blanking the page would feel jarring.
	if (!data) {
		if (error)
			return (
				<div className="p-8 text-center text-rose-700">
					載入失敗:{String(error)}
				</div>
			);
		// First-load skeleton — same outer dimensions as the loaded layout so
		// the header + question card + tab strip don't jump on hydration.
		return <QuestionDetailSkeleton />;
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
		<div className="max-w-3xl md:max-w-none mx-auto px-4 sm:px-6 md:px-4 py-6 sm:py-8 pb-32 md:pb-0">
			{/* In tabs mode the header (回年度 / 上下題 / 檢視切換) rides along with
			    the tab strip in one sticky block, so navigation stays reachable
			    while a long 詳解 scrolls. Columns mode doesn't scroll the page, so
			    the header stays in normal flow there. The bg + edge-bleed keep
			    scrolled content from showing through the blur. */}
			<div
				className={
					tabsMode
						? "md:sticky md:top-14 md:z-20 md:-mx-4 md:px-4 md:pt-3 md:mb-6 md:bg-ink-50/95 md:dark:bg-ink-900/95 md:backdrop-blur"
						: ""
				}
			>
				<header
					className={
						"flex items-center justify-between mb-6 text-sm gap-3" +
						(tabsMode ? " md:mb-2" : "")
					}
				>
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
							{inSearchNav ? (
								<CornerLeftUp size={16} />
							) : (
								<ChevronLeft size={16} />
							)}{" "}
							民國 {data.year} 年
						</Link>
					</div>
					<div className="flex items-center gap-3">
						{/* Columns ⇄ tabs view toggle — desktop only (below lg the page
					    is always one stacked column). Keyboard shortcut: t */}
						<div
							role="group"
							aria-label="切換檢視模式(快捷鍵 t)"
							className="hidden md:flex items-center rounded border border-ink-200 dark:border-ink-700 overflow-hidden"
						>
							<button
								onClick={() => setLayout("tabs")}
								aria-pressed={tabsMode}
								title="分頁檢視:題目/詳解區 (t)"
								className={
									"px-2 py-1.5 transition " +
									(tabsMode
										? "bg-ink-100 dark:bg-ink-700 text-ink-900 dark:text-ink-100"
										: "text-ink-400 dark:text-ink-500 hover:text-ink-700 dark:hover:text-ink-300")
								}
							>
								<AppWindow size={15} />
							</button>
							<button
								onClick={() => setLayout("columns")}
								aria-pressed={!tabsMode}
								title="雙欄檢視 (t)"
								className={
									"px-2 py-1.5 transition border-l border-ink-200 dark:border-ink-700 " +
									(!tabsMode
										? "bg-ink-100 dark:bg-ink-700 text-ink-900 dark:text-ink-100"
										: "text-ink-400 dark:text-ink-500 hover:text-ink-700 dark:hover:text-ink-300")
								}
							>
								<Columns2 size={15} />
							</button>
						</div>
						{navPrev && (
							<button
								onClick={() =>
									navigate(`/q/${navPrev}`, { state: location.state })
								}
								className="inline-flex items-center gap-1 text-ink-500 dark:text-ink-400 hover:text-accent"
							>
								<ChevronLeft size={16} />{" "}
								{inSearchNav ? "上一個結果" : "上一題"}
							</button>
						)}
						{navNext && (
							<button
								onClick={() =>
									navigate(`/q/${navNext}`, { state: location.state })
								}
								className="inline-flex items-center gap-1 text-ink-500 dark:text-ink-400 hover:text-accent"
							>
								{inSearchNav ? "下一個結果" : "下一題"}{" "}
								<ChevronRight size={16} />
							</button>
						)}
					</div>
				</header>

				{/* ≥md has two view modes (header toggle / `t` shortcut):
			    - columns: question left, everything else right — a flex row pinned
			      to the remaining viewport height; each pane is its own scroll
			      container, so the two sides scroll fully independently and the
			      page itself doesn't scroll. The middle handle drags the split.
			    - tabs: one full-width pane at a time behind a 題目/詳解區 tab
			      strip, with normal page scrolling and a comfortable reading width.
			    Below md both modes collapse to the same single stacked column. */}
				{tabsMode && (
					<div className="hidden md:flex flex-wrap border-b border-ink-200 dark:border-ink-700 max-w-4xl mx-auto pt-1 pb-0">
						<TabButton
							active={mainTab === "question"}
							onClick={() => setMainTab("question")}
						>
							題目
						</TabButton>
						<TabButton
							active={mainTab === "explanation"}
							onClick={() => setMainTab("explanation")}
						>
							詳解
						</TabButton>
						<TabButton
							active={mainTab === "note"}
							onClick={() => setMainTab("note")}
						>
							個人筆記
							{data.my_note && (
								<span className="ml-1.5 text-[10px] text-ink-400 dark:text-ink-500">
									●
								</span>
							)}
						</TabButton>
						<TabButton
							active={mainTab === "discussion"}
							onClick={() => setMainTab("discussion")}
						>
							討論串
							<span className="ml-1.5 text-xs text-ink-400 dark:text-ink-500 font-sans">
								({commentCount})
							</span>
						</TabButton>
						<TabButton
							active={mainTab === "similar"}
							onClick={() => setMainTab("similar")}
						>
							相似題目
							<span className="ml-1.5 text-xs text-ink-400 dark:text-ink-500 font-sans">
								({similar.length})
							</span>
						</TabButton>
						{hasVideos && (
							<TabButton
								active={mainTab === "video"}
								onClick={() => setMainTab("video")}
							>
								影片
								<span className="ml-1.5 text-xs text-ink-400 dark:text-ink-500 font-sans">
									({videoCount})
								</span>
							</TabButton>
						)}
					</div>
				)}
			</div>
			<div
				ref={splitRowRef}
				className={tabsMode ? "" : "md:flex md:h-[calc(100vh-9.5rem)]"}
			>
				{/* Left: question stem / options / answer */}
				<div
					className={
						tabsMode
							? "md:max-w-4xl md:mx-auto md:pb-12" +
								(mainTab === "question" ? "" : " md:hidden")
							: "md:h-full md:min-w-0 md:shrink-0 md:overflow-y-auto md:overscroll-contain md:pr-1 md:pb-8"
					}
					style={tabsMode ? undefined : { flexBasis: `${splitPct}%` }}
				>
					<QuestionCard
						key={data.id}
						question={data}
						onAnswered={reload}
						onProgressCleared={reload}
					/>
				</div>

				{/* Drag handle (columns mode, desktop only). Drag to repan the split;
			    double-click to reset to the default ratio. */}
				{!tabsMode && (
					<div
						onPointerDown={onSplitResizeStart}
						onDoubleClick={onSplitResetSplit}
						role="separator"
						aria-orientation="vertical"
						aria-label="調整左右欄寬度（雙擊還原）"
						className="group relative hidden shrink-0 cursor-col-resize select-none items-center justify-center md:flex md:w-6"
					>
						{/* Thin full-height rule + a grab handle that breaks the line so the
					    divider reads as draggable rather than decorative. */}
						<div className="absolute inset-y-0 w-px bg-ink-200 transition-colors group-hover:bg-accent dark:bg-ink-700" />
						<div className="relative z-10 rounded bg-ink-50 py-1 text-ink-300 transition-colors group-hover:text-accent dark:bg-ink-900 dark:text-ink-600">
							<GripVertical size={14} />
						</div>
					</div>
				)}

				{/* Right: 詳解共筆 / 個人筆記 tabs → 相似題目 → 被引用 → 討論 */}
				<div
					className={
						"tiptap-compact mt-8 md:mt-0 " +
						(tabsMode
							? "md:max-w-4xl md:mx-auto md:pb-12" +
								(mainTab === "question" ? " md:hidden" : "")
							: "md:h-full md:min-w-0 md:flex-1 md:overflow-y-auto md:overscroll-contain md:pr-1 md:pb-8")
					}
				>
					{/* 詳解 / 個人筆記 tabs. In tabs mode at ≥md the top strip drives the
			    selection instead (the inner strip below is md:hidden and this whole
			    section yields to the 相似題目 tab). */}
					<section
						className={
							"mt-0" +
							(tabsMode && (mainTab === "similar" || mainTab === "video")
								? " md:hidden"
								: "")
						}
					>
						{/* Columns mode pins this under the pane's own scroll top (md:top-0).
				    Tabs mode has no pane scroller and its own sticky header above,
				    so let this strip (only the OpenEvidence link at ≥md) flow. */}
						<div
							ref={innerStripRef}
							className={
								"sticky top-14 z-10 flex items-center justify-between gap-3 bg-ink-50/95 dark:bg-ink-900/95 backdrop-blur pt-1 pb-3 " +
								(tabsMode ? "md:static" : "md:top-0")
							}
						>
							<div
								className={
									"flex flex-wrap border-b border-ink-200 dark:border-ink-700" +
									(tabsMode ? " md:hidden" : "")
								}
							>
								<TabButton
									active={tab === "explanation"}
									onClick={() => setTab("explanation")}
								>
									詳解共筆
								</TabButton>
								<TabButton
									active={tab === "note"}
									onClick={() => setTab("note")}
								>
									個人筆記
									{data.my_note && (
										<span className="ml-1.5 text-[10px] text-ink-400 dark:text-ink-500">
											●
										</span>
									)}
								</TabButton>
								{/* Discussion tab — only appears in two-pane (lg+) view; on
						    mobile the 討論 section still lives at the bottom of the
						    right column (see `md:hidden` on that section below). */}
								<TabButton
									active={tab === "discussion"}
									onClick={() => setTab("discussion")}
									className="hidden md:inline-flex"
								>
									討論串
									<span className="ml-1.5 text-xs text-ink-400 dark:text-ink-500 font-sans">
										({commentCount})
									</span>
								</TabButton>
								{/* 相似題目 as an inner tab — columns mode at ≥md only
						    (like 討論串); below md and in tabs mode it lives elsewhere. */}
								<TabButton
									active={tab === "similar"}
									onClick={() => setTab("similar")}
									className="hidden md:inline-flex"
								>
									相似題目
									<span className="ml-1.5 text-xs text-ink-400 dark:text-ink-500 font-sans">
										({similar.length})
									</span>
								</TabButton>
								{/* 影片跟 討論串/相似題目 不同,在窄螢幕也留著 —— 卡片本身
						    就是單欄的,不需要寬版面才讀得下去。 */}
								{hasVideos && (
									<TabButton
										active={tab === "video"}
										onClick={() => setTab("video")}
									>
										影片
										<span className="ml-1.5 text-xs text-ink-400 dark:text-ink-500 font-sans">
											({videoCount})
										</span>
									</TabButton>
								)}
							</div>
							{tab === "explanation" && !editing && (
								<a
									href={buildOpenEvidenceUrl(data)}
									target="_blank"
									rel="noopener noreferrer"
									className="ml-auto text-sm text-ink-500 dark:text-ink-400 hover:text-accent inline-flex items-center gap-1"
									title="把題幹+選項丟到 OpenEvidence(不送正解,可當盲解參考)"
								>
									<ExternalLink size={14} /> OpenEvidence
								</a>
							)}
						</div>

						{tab === "explanation" && hasExpDraft && (
							<p className="mb-2 text-xs text-amber-700 dark:text-amber-400">
								↺ 有未送出的詳解草稿——點「編輯」繼續
							</p>
						)}
						{tab === "explanation" &&
							(editing ? (
								<div className="bg-white dark:bg-ink-800 border-2 border-accent/40 rounded-lg p-4 sm:p-5 shadow-paper">
									<div className="mb-3 text-xs text-ink-500 dark:text-ink-400">
										{lockState.status === "held" && (
											<span>
												✓ 你正在編輯 · 鎖至{" "}
												{new Date(lockState.until).toLocaleTimeString("zh-TW")}{" "}
												· 目前版本 v{data.explanation?.version ?? 0}
											</span>
										)}
									</div>
									<RichEditor
										content={draft}
										onChange={(j) => {
											setDraft(j);
											saveDraft(expDraftKey, j);
										}}
										placeholder="輸入詳解。可貼上圖片、@提及他人,輸入 @114 引用題目。"
										autofocus
										toolbarActions={
											<EditorActions
												onCancel={cancelEdit}
												onSave={save}
												saving={saving}
											/>
										}
									/>
									{saveError && (
										<div className="mt-3 p-2 rounded bg-rose-50 dark:bg-rose-900/20 border border-rose-200 dark:border-rose-800 text-rose-800 dark:text-rose-300 text-sm">
											{saveError}
										</div>
									)}
								</div>
							) : hasExplanation ? (
								<>
									<article className="relative bg-white dark:bg-ink-800 border border-ink-200 dark:border-ink-700 rounded-lg p-5 sm:p-7 shadow-paper">
										{/* Toolbar sits in normal flow above the body — absolutely
								    positioned buttons used to sit on top of the first line.
								    In columns mode it pins under the sticky tab strip so the
								    controls stay reachable while a long 詳解 scrolls; the
								    bg + edge-bleed keep body text from showing through. */}
										<div
											className={
												(tabsMode
													? "mb-3"
													: "substick -mx-5 sm:-mx-7 px-5 sm:px-7 pt-1 pb-2 bg-white dark:bg-ink-800 border-b border-ink-100 dark:border-ink-700") +
												" flex flex-wrap items-center justify-end gap-1.5"
											}
											style={
												tabsMode
													? undefined
													: ({ "--strip-h": `${stripH}px` } as CSSProperties)
											}
										>
											{revealedExp && (
												<button
													type="button"
													onClick={() => toggleAutoCloze(data.id, "exp")}
													disabled={autoClozeLoading}
													title="自動挖空:AI 挑出關鍵詞當空格,只在防劇透開著時遮住(點各別揭曉)。再按一次移除這層,不影響你的螢光標記"
													aria-pressed={!!autoClozeTerms?.length}
													className={TOOL_BTN(!!autoClozeTerms?.length)}
												>
													<Sparkles size={14} />{" "}
													{autoClozeLoading
														? "挖空中…"
														: autoClozeTerms?.length
															? `自動挖空 ${autoClozeTerms.length}`
															: "自動挖空"}
												</button>
											)}
											{revealedExp && (
												<button
													type="button"
													onClick={() => setExpCloze((v) => !v)}
													title="防劇透:遮住你的螢光標記(以及自動挖空挑的關鍵詞)來自我測驗,點各別揭曉/收回"
													aria-pressed={expCloze}
													className={TOOL_BTN(expCloze)}
												>
													<Videotape size={14} /> {expCloze ? "取消" : "防劇透"}
												</button>
											)}
											{autoClozeMsg && (
												<span className="self-center text-xs text-ink-400 dark:text-ink-500">
													{autoClozeMsg}
												</span>
											)}
											<button
												onClick={startEdit}
												disabled={
													!online ||
													lockState.status === "acquiring" ||
													lockState.status === "locked-by-other"
												}
												title={online ? undefined : "離線中,無法取得編輯鎖"}
												className="inline-flex items-center gap-1 rounded px-2 py-1 text-sm text-accent hover:bg-accent/10 disabled:opacity-40"
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
												<AnnotatableContent
													content={explanationJson}
													storeKey={`anno:exp:${data.id}`}
													cloze={expCloze}
													autoTerms={autoClozeTerms ?? undefined}
												/>
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
											<ExplanationStats questionId={data.id} />
										</footer>
									</article>
								</>
							) : (
								<>
									<div className="bg-ink-50 dark:bg-ink-800/60 border border-dashed border-ink-200 dark:border-ink-700 rounded-lg p-8 text-center">
										<p className="text-ink-500 dark:text-ink-400 mb-3">
											尚無詳解,你願意第一個寫嗎?
										</p>
										<button
											onClick={startEdit}
											disabled={!online}
											title={online ? undefined : "離線中,無法取得編輯鎖"}
											className="bg-accent hover:bg-accent-dark text-white px-5 py-2 rounded font-medium disabled:opacity-40"
										>
											開始寫詳解
										</button>
									</div>
								</>
							))}

						{tab === "note" && hasNoteDraft && (
							<p className="mb-2 text-xs text-amber-700 dark:text-amber-400">
								↺ 有未送出的筆記草稿——點「編輯」繼續
							</p>
						)}
						{tab === "note" &&
							(noteEditing ? (
								<div className="bg-white dark:bg-ink-800 border-2 border-accent/40 rounded-lg p-4 sm:p-5 shadow-paper">
									<div className="mb-3 text-xs text-ink-500 dark:text-ink-400">
										✎ 個人筆記 · 僅你可見
									</div>
									<RichEditor
										content={noteDraft}
										onChange={(j) => {
											setNoteDraft(j);
											saveDraft(noteDraftKey, j);
										}}
										placeholder="寫下你的私人筆記。可貼圖、@114 引用其他題目。"
										autofocus
										toolbarActions={
											<EditorActions
												onCancel={cancelNoteEdit}
												onSave={saveNote}
												saving={noteSaving}
											/>
										}
									/>
									{noteError && (
										<div className="mt-3 p-2 rounded bg-rose-50 dark:bg-rose-900/20 border border-rose-200 dark:border-rose-800 text-rose-800 dark:text-rose-300 text-sm">
											{noteError}
										</div>
									)}
								</div>
							) : noteJson ? (
								<article className="relative bg-white dark:bg-ink-800 border border-ink-200 dark:border-ink-700 rounded-lg p-5 sm:p-7 shadow-paper">
									<div
										className={
											(tabsMode
												? "mb-3"
												: "substick -mx-5 sm:-mx-7 px-5 sm:px-7 pt-1 pb-2 bg-white dark:bg-ink-800 border-b border-ink-100 dark:border-ink-700") +
											" flex flex-wrap items-center justify-end gap-1.5"
										}
										style={
											tabsMode
												? undefined
												: ({ "--strip-h": `${stripH}px` } as CSSProperties)
										}
									>
										{/* 切換這一題的筆記。mr-auto 把它靠到最左,右邊留給
								    自動挖空 / 防劇透 / 編輯。 */}
										<div className="mr-auto min-w-0">
											<NoteSwitcher
												notes={notes}
												activeSlot={activeSlot}
												busy={notesBusy}
												onSelect={setNoteSlot}
												onCreate={addNote}
												onDelete={removeNote}
											/>
										</div>
										<button
											type="button"
											onClick={() => toggleAutoCloze(data.id, "note")}
											disabled={noteAutoLoading}
											title="自動挖空:AI 從你的筆記挑出關鍵詞當空格,只在防劇透開著時遮住(點各別揭曉)。再按一次移除這層,不影響你的螢光標記"
											aria-pressed={!!noteAutoTerms?.length}
											className={TOOL_BTN(!!noteAutoTerms?.length)}
										>
											<Sparkles size={14} />{" "}
											{noteAutoLoading
												? "挖空中…"
												: noteAutoTerms?.length
													? `自動挖空 ${noteAutoTerms.length}`
													: "自動挖空"}
										</button>
										<button
											type="button"
											onClick={() => setNoteCloze((v) => !v)}
											title="防劇透:遮住你的螢光標記(以及自動挖空挑的關鍵詞)來自我測驗,點各別揭曉/收回"
											aria-pressed={noteCloze}
											className={TOOL_BTN(noteCloze)}
										>
											<Videotape size={14} /> {noteCloze ? "取消" : "防劇透"}
										</button>
										{noteAutoMsg && (
											<span className="self-center text-xs text-ink-400 dark:text-ink-500">
												{noteAutoMsg}
											</span>
										)}
										<button
											onClick={startNoteEdit}
											className="inline-flex items-center gap-1 rounded px-2 py-1 text-sm text-accent hover:bg-accent/10"
										>
											<Pencil size={14} /> 編輯
										</button>
									</div>
									<NoteContent
										content={noteJson}
										annotateKeyPrefix={`anno:note:${data.id}`}
										cloze={noteCloze}
										autoTerms={noteAutoTerms ?? undefined}
									/>
									<footer className="mt-5 pt-3 border-t border-ink-100 dark:border-ink-700 text-xs text-ink-400 dark:text-ink-500">
										僅你可見
										{activeNote?.updated_at && (
											<>
												{" "}
												· 最近編輯{" "}
												{new Date(activeNote.updated_at).toLocaleString(
													"zh-TW",
												)}
											</>
										)}
									</footer>

									{/* 你可能想連結 — 依筆記命中的受控關鍵字(疾病/主題)建議
							    相關題目 與你自己的其他筆記。最多 5 條(連結密度護欄)。 */}
									{noteLinks.length > 0 && (
										<section className="mt-5 pt-4 border-t border-ink-100 dark:border-ink-700">
											<h3 className="flex items-center gap-1.5 text-sm font-medium text-ink-600 dark:text-ink-300 mb-2">
												<LinkIcon size={14} /> 你可能想連結
											</h3>
											<ul className="space-y-1">
												{noteLinks.map((l) => (
													<li key={`${l.targetKind}:${l.targetId}`}>
														<Link
															to={`/q/${l.targetId}`}
															className="group flex items-start gap-2 rounded p-2 -mx-2 hover:bg-ink-50 dark:hover:bg-ink-800/60 transition"
														>
															<span className="font-mono text-xs text-ink-500 dark:text-ink-400 shrink-0 mt-0.5">
																{l.year}-{String(l.number).padStart(3, "0")}
															</span>
															<span className="min-w-0 flex-1">
																<span className="block text-sm text-ink-700 dark:text-ink-200 line-clamp-1 group-hover:text-accent">
																	{l.stem}
																</span>
																<span className="mt-1 flex flex-wrap items-center gap-1">
																	{l.targetKind === "note" && (
																		<span className="rounded-full bg-accent/10 text-accent text-[11px] px-1.5 py-0.5">
																			你的筆記
																		</span>
																	)}
																	{l.sharedTerms.slice(0, 4).map((t) => (
																		<span
																			key={t}
																			className="rounded-full bg-ink-100 dark:bg-ink-700 text-ink-500 dark:text-ink-300 text-[11px] px-1.5 py-0.5"
																		>
																			{t}
																		</span>
																	))}
																</span>
															</span>
														</Link>
													</li>
												))}
											</ul>
										</section>
									)}
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
							<div className="hidden md:block mt-2">
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

					{/* 策展影片 — 依主題分組。跟 討論串/相似題目 不同,窄螢幕也走 tab
			    (不落在頁面流的底部):影片卡本來就是單欄的,不需要寬版面。
			    基準 class 用 tab(<md 只有內層 strip 生效),md: 再依模式覆寫。 */}
					{hasVideos && (
						<section
							className={
								(tab === "video" ? "block" : "hidden") +
								" mt-8 " +
								((tabsMode ? mainTab === "video" : tab === "video")
									? "md:block"
									: "md:hidden")
							}
						>
							<div className="mb-4 flex items-baseline justify-between gap-3">
								<h2 className="font-serif text-lg text-ink-800 dark:text-ink-100">
									教學影片
								</h2>
								<Link
									to="/videos"
									className="text-xs text-ink-500 hover:text-accent dark:text-ink-400"
								>
									影片庫 →
								</Link>
							</div>
							<p className="mb-4 text-xs text-ink-400 dark:text-ink-500">
								依這題的標籤對到的主題。覺得哪支不好,滑過卡片右上角可以移除
								——移除是全站生效的。
							</p>
							{videoTopics.map((g) => (
								<VideoTopicSection
									key={g.slug}
									group={g}
									onRemoved={dropVideo}
								/>
							))}
						</section>
					)}

					{/* 相似題目 — tag-overlap with BM25 fallback. Hidden when empty, except
			    on the tabs-mode 相似題目 tab, which shows an empty state instead.
			    Below md / in columns mode it keeps its place in the flow; in tabs
			    mode at ≥md it only appears under the 相似題目 top tab. */}
					<section
						className={
							"mt-8 " +
							(similar.length > 0 ? "block" : "hidden") +
							((tabsMode ? mainTab === "similar" : tab === "similar")
								? " md:block"
								: " md:hidden")
						}
					>
						<div className="flex items-center justify-between mb-3">
							<h2 className="font-serif text-lg text-ink-800 dark:text-ink-100">
								相似題目
							</h2>
							<Link
								to={`/drill/${data.id}`}
								className="inline-flex items-center gap-1.5 rounded-full bg-accent hover:bg-accent-dark text-white text-sm px-4 py-1.5 transition"
								title="把語意相近、跨年份的題目混在一起練 (interleaving)"
							>
								<RefreshCcw size={14} /> 開始交錯練習
							</Link>
						</div>
						{similar.length === 0 && (
							<p className="text-sm text-ink-400 dark:text-ink-500">
								尚無相似題目。
							</p>
						)}
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
											(s.source === "vec"
												? "bg-accent/10 text-accent dark:bg-accent/20 dark:text-accent-light"
												: s.source === "tag"
													? "bg-emerald-50 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300"
													: "bg-ink-100 text-ink-600 dark:bg-ink-700 dark:text-ink-300")
										}
										title={
											s.source === "vec"
												? "語意相似 (向量)"
												: s.source === "tag"
													? "共用標籤數"
													: "文字相似 (BM25)"
										}
									>
										{s.source === "vec"
											? "語意相似"
											: s.source === "tag"
												? `共 ${s.shared_tags} 個 tag`
												: "文字相似"}
									</span>
								</li>
							))}
						</ul>
					</section>

					{/* Back-references — appears only when other questions/comments cite
			    this one. In tabs mode at ≥md it lives under the 相似題目 tab. */}
					{data.back_refs.length > 0 && (
						<section
							className={
								"mt-10" +
								((tabsMode ? mainTab !== "similar" : tab !== "similar")
									? " md:hidden"
									: "")
							}
						>
							<h2 className="font-serif text-lg text-ink-800 dark:text-ink-100 mb-3 inline-flex items-center gap-2">
								<LinkIcon
									size={16}
									className="text-ink-400 dark:text-ink-500"
								/>{" "}
								被引用 ({data.back_refs.length})
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
			    `hidden md:inline-flex`), so we hide this bottom section there to
			    avoid rendering CommentThread twice and double-fetching. */}
					<section className="mt-12 md:hidden">
						<h2 className="font-serif text-xl text-ink-800 dark:text-ink-100 mb-3">
							討論
						</h2>
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
					</section>
				</div>
				{/* /right column */}
			</div>
			{/* /two-column grid */}
		</div>
	);
}

// Compact 取消 / 儲存 pair sized to sit at the right end of the editor toolbar.
function EditorActions({
	onCancel,
	onSave,
	saving,
}: {
	onCancel: () => void;
	onSave: () => void;
	saving: boolean;
}) {
	return (
		<>
			<button
				type="button"
				onClick={onCancel}
				disabled={saving}
				className="px-2.5 py-1 text-xs rounded text-ink-500 dark:text-ink-400 hover:text-ink-800 dark:hover:text-ink-100 hover:bg-ink-100 dark:hover:bg-ink-700 disabled:opacity-40"
			>
				取消
			</button>
			<button
				type="button"
				onClick={onSave}
				disabled={saving}
				className="px-3 py-1 text-xs rounded bg-accent hover:bg-accent-dark text-white font-medium disabled:opacity-40"
			>
				{saving ? "儲存中…" : "儲存"}
			</button>
		</>
	);
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
	// Caller-supplied responsive classes (e.g. "hidden md:inline-flex") for
	// tabs that should only appear at certain breakpoints. Appended to the
	// base styling rather than replacing it.
	className?: string;
}) {
	return (
		<button
			onClick={onClick}
			className={
				"px-4 py-2 -mb-px border-b-2 font-serif text-base whitespace-nowrap transition " +
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

// 共筆詳解的協作訊號。刻意不是投票:詳解是一列可被整份改寫的活文件,票會
// 活得比它背書的內容久,變成誤導訊號。這裡只陳述事實 —— 幾個人動過、第幾版。
// 不排名、不比較人。
function ExplanationStats({ questionId }: { questionId: string }) {
	const [stats, setStats] = useState<{
		contributors: number;
		versions: number;
	} | null>(null);

	useEffect(() => {
		let alive = true;
		api
			.get<{ contributors: number; versions: number }>(
				`/api/questions/${questionId}/explanation/stats`,
			)
			.then((s) => {
				if (alive) setStats(s);
			})
			.catch(() => {
				/* 訊號而已,拿不到就不顯示 */
			});
		return () => {
			alive = false;
		};
	}, [questionId]);

	if (!stats || stats.contributors === 0) return null;
	return (
		<span className="block mt-1">
			{stats.contributors} 人共筆 · 第 {stats.versions} 版
		</span>
	);
}

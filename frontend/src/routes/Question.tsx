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
	Trash2,
	LinkIcon,
	Search as SearchIcon,
	Eye,
	ExternalLink,
	GripVertical,
	Videotape,
	Sparkles,
	RefreshCcw,
	Expand,
	Shrink,
} from "lucide-react";
import { api, ApiError } from "../lib/api";
import { loadDraft, saveDraft, clearDraft } from "../lib/drafts";
import { noteTitle, noteTitleFromJson } from "../lib/noteTitle";
import { NoteSwitcher, type NoteMeta } from "../components/NoteSwitcher";
import {
	NoteToolButtons,
	NoteToolsMenu,
	type NoteTool,
} from "../components/NoteToolsMenu";
import { useNarrow } from "../hooks/useNarrow";
import {
	TabOverflowItem,
	TabOverflowMenu,
} from "../components/TabOverflowMenu";
import { buildOpenEvidenceUrl } from "../lib/openevidence";
import { useQuestion } from "../hooks/useQuestion";
import { useLock } from "../hooks/useLock";
import { useMe } from "../hooks/useMe";
import { useOnline } from "../hooks/useOnline";
import { QuestionCard } from "../components/QuestionCard";
import { GamepadFab, type GamepadHint } from "../components/GamepadFab";
import { useGamepad, useGamepadScroll } from "../hooks/useGamepad";
import { RichEditor } from "../components/RichEditor";
import { AnnotatableContent } from "../components/AnnotatableContent";
import { NoteContent } from "../components/NoteContent";
import { NoteLinkList, type NoteLinkItem } from "../components/NoteLinkList";
import { CommentThread } from "../components/CommentThread";
import { BookmarkBadge } from "../components/BookmarkBadge";
import { QuestionDetailSkeleton } from "../components/Skeleton";
import { BackToTopFab } from "../components/BackToTopFab";
import { KeepAlive } from "../components/KeepAlive";
import { searchNeighbors } from "../lib/searchCache";
import {
	HEADING_SELECTOR,
	nextHeadingIndex,
	nextSlot,
} from "../lib/headingCursor";
import {
	questionCache,
	yearListCache,
	type YearListItem,
} from "../lib/questionCache";
import { commentCache, seedEmptyComments } from "../lib/commentApi";
import { withAnswer, withProgressCleared } from "../lib/questionProgress";
import {
	recordAnswer as recordLocalAnswer,
	forgetAnswer as forgetLocalAnswer,
} from "../lib/localAnswers";
import { rememberAutoCloze, wasAutoCloze } from "../lib/clozePref";
import {
	VideoTopicSection,
	type VideoTopicGroup,
} from "../components/VideoList";

// Resizable two-pane split (≥md). `splitPct` is the left pane's share of the
// row width; the rest goes to the right pane. Persisted as a UI layout pref.
const SPLIT_MIN = 28;
const SPLIT_MAX = 72;

// Pixels per d-pad press when it is scrolling rather than picking an option.
// The d-pad auto-repeats every 120ms while held, so this is ~1000px/s sustained
// — brisk enough to cross a long 詳解, slow enough to read on the way.
const GAMEPAD_SCROLL_STEP = 120;

// 四份說明:同一顆十字鍵在作答前選選項、揭曉後捲頁面、看筆記時跳標題,寫成
// 一份會騙人。
//
// 每一行都寫出**失效條件**(「選了選項才有」「只有一則時無作用」)。按下去沒反應
// 的鍵最傷:使用者分不出是自己按錯、手把沒連上、還是這一頁本來就沒這個功能,而
// 前兩者會讓人開始懷疑整套手把操作。
const GAMEPAD_HINTS_SHARED: GamepadHint[] = [
	{ btn: "FACE ▲", label: "複製題目為 Markdown" },
	{ btn: "FACE ▶", label: "收藏 / 取消收藏" },
	{ btn: "L1 / R1", label: "上一題 / 下一題(不連發,一下一題)" },
	{ btn: "L2 / R2", label: "上一個 / 下一個分頁(詳解 / 筆記 / 討論…)" },
	{ btn: "START", label: "回這一年的題目列表" },
	{ btn: "SELECT", label: "開關這份說明" },
	{ btn: "左搖桿", label: "捲動(推愈滿捲愈快)" },
];
const GAMEPAD_HINTS_ANSWERING: GamepadHint[] = [
	{ btn: "DPAD ↑ ↓", label: "選擇選項(可長按連選)" },
	{ btn: "DPAD ← →", label: "作答信心 猜 / 普通 / 有把握(選了選項才有)" },
	{ btn: "FACE ▼", label: "送出答案" },
	{ btn: "FACE ◀", label: "略過 / 直接看答案" },
	...GAMEPAD_HINTS_SHARED,
];
// 揭曉後十字鍵改捲動 —— 捲的是「目前這一欄」,不一定是詳解:討論串、相似題目、
// 影片分頁底下捲的是那一頁的內容。寫死「捲動詳解」在那三個分頁上是假的。
const GAMEPAD_HINTS_REVEALED: GamepadHint[] = [
	{ btn: "DPAD ↑ ↓", label: "捲動目前這一欄(可長按)" },
	...GAMEPAD_HINTS_SHARED,
];
// 讀詳解時四顆面鍵改對應詳解工具列。這裡不 spread SHARED —— FACE ▲ / ▶ 的
// 意思被換掉了,照抄那份會寫出兩行互相矛盾的說明。
const GAMEPAD_HINTS_EXPLANATION: GamepadHint[] = [
	{ btn: "DPAD ↑ ↓", label: "捲動詳解(可長按)" },
	{ btn: "FACE ▼", label: "顯示詳解(詳解還糊著時)" },
	{ btn: "FACE ▲", label: "自動挖空(顯示詳解後才有)" },
	{ btn: "FACE ◀", label: "防劇透:遮住 / 掀開(顯示詳解後才有)" },
	{ btn: "FACE ▶", label: "編輯詳解(離線或別人正在編輯時無效)" },
	{ btn: "L1 / R1", label: "上一題 / 下一題(不連發,一下一題)" },
	{ btn: "L2 / R2", label: "上一個 / 下一個分頁(詳解 / 筆記 / 討論…)" },
	{ btn: "START", label: "回這一年的題目列表" },
	{ btn: "SELECT", label: "開關這份說明" },
	{ btn: "左搖桿", label: "捲動(推愈滿捲愈快)" },
];
// 看個人筆記時十字鍵改成走訪筆記本身。
const GAMEPAD_HINTS_NOTE: GamepadHint[] = [
	{ btn: "DPAD ↑ ↓", label: "在筆記標題之間移動(這則沒有標題時改捲動)" },
	{ btn: "FACE ▼", label: "展開 / 收合游標所在那一段" },
	{ btn: "DPAD ← →", label: "切換這一題的筆記(只有一則時無作用)" },
	...GAMEPAD_HINTS_SHARED,
];
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

// 建議的目標自 0040 起多了 'free'(自由筆記)—— 型別跟渲染共用同一份定義,
// 免得又出現「多一種 kind 但某一邊沒處理」的死連結。
type NoteLink = NoteLinkItem;

export function Question() {
	const { id } = useParams<{ id: string }>();
	const { me } = useMe();
	const { data, error, reload, setData } = useQuestion(id);
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
	// Which pane is visible in tabs mode.
	const [mainTab, setMainTab] = useState<MainTab>("question");

	// ── 手機沿用桌機那一組分頁,不另做一套 (#96) ──────────────────────────
	// <md 以前是把兩欄直接疊起來:題目卡在上、詳解/筆記/討論全部在下。一張含五個
	// 選項的題目卡就吃掉一整個手機螢幕,所以「看詳解」永遠要先捲過整張卡。
	//
	// 修法是**讓窄螢幕直接進入 tabs 模式**,而不是給手機另一套兩段式導覽 —— 一頁
	// 兩層分頁(題目/詳解區 再 詳解共筆/個人筆記/…)光是要解釋「哪一層管什麼」就
	// 已經輸了,而且每次加分頁都要記得改兩個地方。`layout` 仍然只記桌機的偏好,
	// 窄螢幕只是無條件覆寫成 tabs。
	const [narrow, setNarrow] = useState(
		() =>
			typeof window !== "undefined" &&
			!window.matchMedia("(min-width: 768px)").matches,
	);
	useEffect(() => {
		const mq = window.matchMedia("(min-width: 768px)");
		const onChange = () => setNarrow(!mq.matches);
		mq.addEventListener("change", onChange);
		return () => mq.removeEventListener("change", onChange);
	}, []);
	const tabsMode = layout === "tabs" || narrow;

	// tabs 模式底下所有的顯示/隱藏原本都寫成 `md:hidden` / `md:block` —— 那是因為
	// 它以前只在 ≥md 存在。窄螢幕也走 tabs 之後,那些前綴在 <md 一律不生效,分頁
	// 會全部同時攤開。這兩個字串把「該用哪一種」集中在一處,而不是散在十處
	// `narrow ? … : …` 三元式裡。
	const mdHidden = narrow ? "hidden" : "md:hidden";
	const mdBlock = narrow ? "block" : "md:block";
	// 切分頁要回到頂端:窄螢幕下每個分頁共用同一條頁面捲軸,不歸零的話從長長的
	// 詳解切回題目,會落在題目卡底下的空白處,看起來像整頁空了。
	const pickTab = useCallback(
		(t: MainTab) => {
			setMainTab(t);
			if (narrow) window.scrollTo({ top: 0 });
		},
		[narrow],
	);

	// Reported up by QuestionCard so the gamepad knows whether the d-pad is
	// still picking options or has become a scroll control. The right column is
	// the scroll container in columns mode.
	const [cardRevealed, setCardRevealed] = useState(false);
	const rightColRef = useRef<HTMLDivElement>(null);
	// 個人筆記面板的容器 —— 手把在裡面找可展開的標題按鈕。
	const notePaneRef = useRef<HTMLDivElement>(null);

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

	// 手機上 回年度/上一題/下一題 那一列也是 sticky(見下面的 navBarClass),所以
	// 它底下那兩層 sticky —— 詳解共筆 tab 條、每欄的工具列 —— 得再往下讓出它的
	// 高度,否則會疊在一起。量法跟 --strip-h 同一套,值透過 --nav-h 往下傳。
	// ≥md 用不到:那裡 columns 模式各欄自己捲,tabs 模式的 tab 條是 md:static。
	const navBarRef = useRef<HTMLDivElement>(null);
	const [navH, setNavH] = useState(0);
	useEffect(() => {
		const el = navBarRef.current;
		if (!el) return;
		const update = () => setNavH(el.offsetHeight);
		update();
		const ro = new ResizeObserver(update);
		ro.observe(el);
		return () => ro.disconnect();
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
	// 個人筆記卡片放大成整個視窗(#115)。刻意**不**用 Fullscreen API:
	// iOS Safari 對非 <video> 的元素沒有 requestFullscreen,而這個站大半的閱讀
	// 都在手機上 —— 一顆在 iPhone 上按了沒反應的按鈕比沒有更糟(同
	// ViewportModeFab 的理由)。改成給同一個 <article> 換 class,DOM 不動,
	// 所以 NoteContent / TipTap 不會重掛。
	const [noteFullscreen, setNoteFullscreen] = useState(false);
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

	// 骨架延後出現的計時器。見下方 `if (!data)` 的說明。
	const [showSkeleton, setShowSkeleton] = useState(false);
	useEffect(() => {
		if (data) {
			setShowSkeleton(false);
			return;
		}
		const t = window.setTimeout(() => setShowSkeleton(true), 120);
		return () => window.clearTimeout(t);
	}, [data, id]);

	// 換題時把捲動位置歸零。元件不重掛(同一個 /q/:id 路由),所以捲動不會自己回到
	// 頂端 —— 在下一題上停在半空中,是先前最容易被誤認成「載入失敗」的症狀之一。
	// columns 模式的右欄是自己的捲動容器,得另外歸零。
	const contentRef = useRef<HTMLDivElement>(null);
	const lastNavigatedId = useRef<string | null>(null);
	useEffect(() => {
		if (!data?.id) return;
		const first = lastNavigatedId.current === null;
		const changed = lastNavigatedId.current !== data.id;
		lastNavigatedId.current = data.id;
		if (!changed || first) return;

		window.scrollTo({ top: 0, behavior: "auto" });
		if (rightColRef.current) rightColRef.current.scrollTop = 0;

		// 預抓命中時內容是瞬間換掉的,快到眼睛會懷疑「到底有沒有換」。一次 140ms 的
		// 淡入補回那個「換了」的訊號。用 WAAPI 而不是 key/remount:重掛整棵子樹會
		// 連 TipTap 一起重建,那正是 2026-07 iOS 白屏的成因(見 CLAUDE.md)。
		if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
		contentRef.current?.animate?.([{ opacity: 0.4 }, { opacity: 1 }], {
			duration: 140,
			easing: "ease-out",
		});
	}, [data?.id]);

	// In tabs mode, land on 題目 for every new question — arriving on 詳解區
	// after prev/next would spoil the answer before the user attempts it.
	useEffect(() => {
		setMainTab("question");
		// 換題也要退出筆記全螢幕:那張卡是 fixed inset-0,留著的話下一題會直接
		// 開在一張蓋住整頁的筆記上,連題目都看不到。
		setNoteFullscreen(false);
	}, [data?.id]);

	// Esc 退出。全螢幕遮住了「上一題/下一題」與導覽列,所以一定要有一條不必
	// 先找到那顆按鈕的退路。
	useEffect(() => {
		if (!noteFullscreen) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") setNoteFullscreen(false);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [noteFullscreen]);

	// Seed/refresh the comment-count badge from the question payload. Kept in
	// sync via onCountChange when CommentThread is mounted.
	useEffect(() => {
		if (typeof data?.comment_count === "number") {
			setCommentCount(data.comment_count);
		}
	}, [data?.id, data?.comment_count]);

	// 雙欄模式下 討論串 / 相似題目 這兩個內層分頁是 md 以上才有的(窄螢幕那時候
	// 它們攤在頁面流的底部),所以視窗縮到 <md 要把人拉回詳解,免得停在一個看不見
	// 又沒有內容的分頁上。
	//
	// **窄螢幕現在一律走 tabs 模式,那裡這兩個分頁是真的存在的** —— 少了 tabsMode
	// 這個條件,使用者在手機上點「討論串」會被這條 effect 立刻彈回詳解:上面那條
	// strip 顯示討論串已選取,底下卻是詳解,而且完全無聲。
	useEffect(() => {
		if (tabsMode) return;
		if (tab !== "discussion" && tab !== "similar") return;
		const mq = window.matchMedia("(min-width: 768px)");
		const sync = () => {
			if (!mq.matches) setTab("explanation");
		};
		sync();
		mq.addEventListener("change", sync);
		return () => mq.removeEventListener("change", sync);
	}, [tab, tabsMode]);

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

	// Prev/next in same year. 走 yearListCache,所以在同一年度內換題時清單是現成
	// 的 —— 上一題/下一題按鈕跟題目同一幀出現,不再慢半拍。
	const yearKey = data ? String(data.year) : "";
	// 值一律從 cache 同步讀;這個 state 只負責「背景抓完了,重繪一次」。
	const [yearListVersion, setYearListVersion] = useState(0);
	const yearList: YearListItem[] = useMemo(
		() => (yearKey ? (yearListCache.peek(yearKey) ?? []) : []),
		// biome-ignore lint/correctness/useExhaustiveDependencies: yearListVersion 是刻意的重繪觸發器
		[yearKey, yearListVersion],
	);
	useEffect(() => {
		if (!yearKey || yearListCache.isFresh(yearKey)) return;
		let cancelled = false;
		yearListCache
			.get(yearKey)
			.then(() => {
				if (!cancelled) setYearListVersion((v) => v + 1);
			})
			.catch(() => {
				/* 清單抓不到就沒有 prev/next,不影響閱讀本題 */
			});
		return () => {
			cancelled = true;
		};
	}, [yearKey]);

	const neighbors = useMemo<{ prev?: string; next?: string }>(() => {
		if (!data) return {};
		const idx = yearList.findIndex((q) => q.id === data.id);
		if (idx < 0) return {};
		return {
			prev: idx > 0 ? yearList[idx - 1].id : undefined,
			next: idx < yearList.length - 1 ? yearList[idx + 1].id : undefined,
		};
	}, [yearList, data?.id]);

	// When arriving from 搜尋 and the result set is still cached, prev/next walk
	// the *search result* order (across years) rather than same-year neighbours.
	// Cache miss (stale / reloaded) → null → we fall back to `neighbors` and the
	// plain 上一題/下一題 labels. Read during render — it's a cheap pure lookup.
	const searchNav =
		data && fromSearch ? searchNeighbors(fromSearch, data.id) : null;
	const inSearchNav = searchNav !== null;
	const navPrev = searchNav ? (searchNav.prev ?? undefined) : neighbors.prev;
	const navNext = searchNav ? (searchNav.next ?? undefined) : neighbors.next;

	// 這裡是「換題不再有等待」的關鍵:上下題的 id 在按鈕出現時就已知,趁瀏覽器閒
	// 置先把 payload 抓進 questionCache,真的按下去時 useQuestion 同步就讀得到。
	// 排在 idle 而不是立刻,是為了不跟本題自己的請求(詳解、留言、相似題)搶頻寬。
	// 離線時不抓 —— 只會失敗,還白白喚醒 Service Worker。
	useEffect(() => {
		if (!online || (!navNext && !navPrev)) return;
		const run = () => {
			questionCache.prefetch(navNext);
			questionCache.prefetch(navPrev);
		};
		const ric = window.requestIdleCallback;
		if (typeof ric === "function") {
			const handle = ric(run, { timeout: 2000 });
			return () => window.cancelIdleCallback?.(handle);
		}
		// Safari 沒有 requestIdleCallback(至 Safari 18 仍缺),退回一個小延遲。
		const t = window.setTimeout(run, 400);
		return () => window.clearTimeout(t);
	}, [navNext, navPrev, online]);

	// 指標一碰到按鈕就開抓,等於在點擊前偷到 ~100ms。idle 預抓已經命中時
	// prefetch() 自己會 no-op,所以這只是保險(idle 還沒輪到、或剛好過期)。
	const warm = useCallback((id: string | undefined) => {
		questionCache.prefetch(id);
	}, []);

	// 討論串:大多數題目底下一則留言都沒有,而那件事題目 payload 已經講了
	// (`comment_count`)。零則就直接把空陣列寫進快取 —— 點開分頁是同步命中,
	// 一次網路都不發。有留言才值得預抓,而且排在 idle,不跟題目本身搶頻寬。
	//
	// 這裡刻意**不**預抓鄰居題的留言:那會把「換題順一點」換成每換一題多一趟
	// 請求,而使用者多半根本不會打開討論串。
	useEffect(() => {
		if (!data) return;
		if (data.comment_count === 0) {
			seedEmptyComments(data.id);
			return;
		}
		if (!online) return;
		const run = () => commentCache.prefetch(data.id);
		const ric = window.requestIdleCallback;
		if (typeof ric === "function") {
			const handle = ric(run, { timeout: 3000 });
			return () => window.cancelIdleCallback?.(handle);
		}
		const t = window.setTimeout(run, 600);
		return () => window.clearTimeout(t);
	}, [data?.id, data?.comment_count, online]);

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

	// OpenEvidence 匯入時勾了「一則回答存一則筆記」:每份文件各佔一則。
	//
	// 目前這則是空的(常見流程是「新增筆記 → 馬上匯入」)就讓第一份直接佔用它,
	// 不白留一則空筆記;有內容就先幫它存起來 —— 匯入完畫面會切到新筆記,把使用者
	// 手上那份沒送出的草稿丟掉不能接受,而存起來正是他按「儲存」會發生的事。
	//
	// 每份都是先 PUT 再 POST 下一則:POST 取的是 MAX(slot)+1,順序顛倒的話兩份會
	// 搶到同一個號碼。全部直接寫進伺服器,不留「已存好幾則、但手上這則還沒按儲存」
	// 的半吊子狀態。
	async function importOeAsNotes(docs: any[]) {
		if (!data || docs.length === 0) return;
		const qid = data.id;
		const reuseActive = noteTitle(noteDraft, "") === "";
		const written: number[] = [];
		let failure: string | null = null;
		setNotesBusy(true);
		setNoteError(null);
		try {
			if (!reuseActive) {
				await api.put(`/api/questions/${qid}/note`, {
					content_json: noteDraft,
					slot: activeSlot,
				});
			}
			for (const doc of docs) {
				const slot =
					written.length === 0 && reuseActive
						? activeSlot
						: (await api.post<{ slot: number }>(`/api/questions/${qid}/notes`))
								.slot;
				await api.put(`/api/questions/${qid}/note`, {
					content_json: doc,
					slot,
				});
				written.push(slot);
			}
		} catch (e) {
			failure =
				e instanceof ApiError && e.status === 409
					? `這一題的筆記數量已達上限,只匯入了 ${written.length} / ${docs.length} 則。`
					: `匯入到第 ${written.length + 1} 則時失敗:${String(e)}`;
		} finally {
			setNotesBusy(false);
		}
		await reload();
		if (failure) {
			// 半途失敗就把編輯器留著 —— noteError 只畫在編輯畫面上,收掉等於沒說。
			// 但若第一份已經寫進目前這個 slot,手上那份空草稿就對不上了:不同步的話
			// 使用者接著按「儲存」會用空文件蓋掉剛匯入的內容。
			if (reuseActive && written.length > 0) setNoteDraft(docs[0]);
			setNoteError(failure);
			return;
		}
		clearDraft(noteDraftKey);
		setNoteEditing(false);
		setNoteDraft(null);
		setNoteSlot(written[0]);
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

	// 這一排的三顆工具。定義一次,由寬度決定畫成按鈕還是收進「更多」。
	// <sm 時:筆記工具收進「更多」、分頁列尾端摺進 <EllipsisVertical />。
	const tabsNarrow = useNarrow();
	const noteToolsNarrow = tabsNarrow;
	const noteTools: NoteTool[] = [
		{
			key: "cloze",
			icon: <Sparkles size={14} />,
			label: noteAutoLoading
				? "挖空中…"
				: noteAutoTerms?.length
					? `自動挖空 ${noteAutoTerms.length}`
					: "自動挖空",
			onClick: () => data && toggleAutoCloze(data.id, "note"),
			disabled: noteAutoLoading,
			active: !!noteAutoTerms?.length,
			title:
				"自動挖空:AI 從你的筆記挑出關鍵詞當空格,只在防劇透開著時遮住(點各別揭曉)。再按一次移除這層,不影響你的螢光標記",
		},
		{
			key: "spoiler",
			icon: <Videotape size={14} />,
			label: noteCloze ? "取消防劇透" : "防劇透",
			onClick: () => setNoteCloze((v) => !v),
			active: noteCloze,
			title:
				"防劇透:遮住你的螢光標記(以及自動挖空挑的關鍵詞)來自我測驗,點各別揭曉/收回",
		},
		{
			key: "edit",
			icon: <Pencil size={14} />,
			label: "編輯",
			onClick: startNoteEdit,
			accent: true,
		},
	];

	// 拖曳重排(#140)。伺服器整批寫 sort_order —— 不動 slot,因為畫記
	// (anno:note:<qid>:<slot>)與挖空快取都以它定位(見 migration 0041)。
	//
	// 失敗就 reload 把畫面拉回伺服器的真相:切換器在放開的當下已經樂觀重排過,
	// 留著會讓使用者以為存好了。
	async function reorderNotes(slots: number[]) {
		if (!data) return;
		try {
			await api.put(`/api/questions/${data.id}/notes/order`, { slots });
		} catch (e) {
			setNoteError(String(e));
		}
		await reload();
	}

	// Cycle the tab strip one step. Which strip that is depends on the layout:
	// tabs mode drives the top 題目/詳解/… strip, columns mode drives the right
	// column's own. Shared by the h/l keys and L2/R2 on the gamepad.
	//
	// 判準是 `tabsMode`,不是「≥md 而且 tabsMode」。#96 之後窄螢幕一律是 tabs
	// 模式,而那裡的右欄在題目分頁下整欄 `hidden` —— 去切它自己的 tab 畫面一個
	// 像素都不會動,按起來就像手把那兩顆鍵壞了(桌機看不出來,那裡走另一條分支)。
	// 反過來說,非 tabs 模式只可能發生在 ≥md(窄螢幕被無條件覆寫成 tabs),所以
	// else 分支不必再問一次寬度。
	function cycleTab(dir: 1 | -1) {
		if (tabsMode) {
			// 影片 tab 只在有影片時存在,循環順序也要跟著少一格。
			const order: MainTab[] = [
				"question",
				"explanation",
				"note",
				"discussion",
				"similar",
				...(hasVideos ? (["video"] as MainTab[]) : []),
			];
			const i = order.indexOf(mainTab);
			// pickTab 而不是 setMainTab:窄螢幕下所有分頁共用同一條頁面捲軸,不捲
			// 回頂端的話,從長長的詳解切回題目會落在題目卡底下的空白處。
			pickTab(order[((i < 0 ? 0 : i) + dir + order.length) % order.length]);
		} else {
			const order: Tab[] = [
				"explanation",
				"note",
				"discussion",
				"similar",
				...(hasVideos ? (["video"] as Tab[]) : []),
			];
			const i = order.indexOf(tab);
			const base = i < 0 ? 0 : i;
			setTab(order[(base + dir + order.length) % order.length]);
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
			cycleTab(k === "l" ? 1 : -1);
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

	// Which element the gamepad scrolls. In columns mode at ≥md the page itself
	// doesn't scroll — each column is its own scroll container — so `window`
	// would be a no-op; the long content (詳解/筆記/討論) lives in the right one.
	// tabs mode and mobile scroll the page normally, hence null.
	function gamepadScrollEl(): HTMLElement | null {
		const md = window.matchMedia("(min-width: 768px)").matches;
		return !tabsMode && md ? rightColRef.current : null;
	}
	function gamepadScrollBy(dy: number) {
		const el = gamepadScrollEl();
		if (el) el.scrollTop += dy;
		else window.scrollBy(0, dy);
	}
	useGamepadScroll(gamepadScrollEl);

	// 個人筆記在看的時候,十字鍵改成走訪筆記本身,而不是捲頁面:
	//   ↑ ↓  在**目前展開得到的** h1/h2/h3 之間移動
	//   FACE ▼ 展開 / 收合游標所在的那個區段
	//   ← →  切換這一題底下的多則筆記
	// 標題清單直接問 DOM —— 收合的區段不渲染子節點,所以 DOM 裡有的按鈕定義上
	// 就是使用者現在看得到的那些,展開一個區段它的子標題自動加入,不必同步。
	const noteHeadings = useCallback(
		() =>
			Array.from(
				notePaneRef.current?.querySelectorAll<HTMLElement>(HEADING_SELECTOR) ??
					[],
			),
		[],
	);
	const headingIdx = useRef(-1);
	// 換題、換筆記、收合造成清單變動 → 游標重來,免得指到別份內容的第 N 個標題。
	useEffect(() => {
		headingIdx.current = -1;
	}, [data?.id, activeSlot]);

	function moveHeading(delta: number) {
		const items = noteHeadings();
		const next = nextHeadingIndex(headingIdx.current, items.length, delta);
		headingIdx.current = next;
		if (next < 0) return false;
		items[next].focus();
		// 刻意**不**用 behavior: "smooth"。走訪是「跳到下一個標題」這個離散動作,
		// 平滑捲動會把它畫成一段連續位移 —— 而量出來每跳一次是 45–63px,跟
		// GAMEPAD_SCROLL_STEP 的 120px 同一量級,於是使用者讀到的是「頁面在捲」
		// 而不是「游標在動」,整個功能看起來像沒接上。e-ink 上還多一層代價:
		// 平滑捲動的每一幀都是一次全螢幕重繪,拖出一連串殘影。
		items[next].scrollIntoView({ block: "center" });
		return true;
	}

	// 筆記分頁是不是正在被看:欄位版兩欄同時可見,分頁版要看 mainTab。
	const noteTabVisible =
		tab === "note" && (!tabsMode || mainTab === "note") && !noteEditing;

	// 讀詳解時四顆面鍵改對應詳解工具列 —— 那排按鈕是讀的時候真正會用到的東西,
	// 而「複製題目」「收藏」在讀的時候用不上。
	//
	// 一定要 cardRevealed:還沒作答時 FACE ▼ 是送出、FACE ◀ 是略過看答案,那兩顆
	// 歸 QuestionCard。搶在答題前接管,等於按下送出的同時把詳解也掀開了。
	// 這裡問的是 `mainTab === "explanation"`,不是 `"note"`。分頁版底下 `tab` 是
	// 跟著 `mainTab` 走的(見上面那條同步 effect),所以拿 note 去比對必然是
	// `tab === "explanation" && mainTab === "note"` —— 兩者互斥,整條永遠是 false。
	// 症狀是無聲的:分頁版(手機一律、桌機選了分頁版型)讀詳解時那四顆面鍵完全
	// 不接管,說明面板也就永遠顯示不到 GAMEPAD_HINTS_EXPLANATION 那一份。
	const expKeysActive =
		tab === "explanation" &&
		(!tabsMode || mainTab === "explanation") &&
		cardRevealed &&
		!editing &&
		!noteEditing;

	// Gamepad page bindings. Options / 送出 / 複製 / 收藏 are QuestionCard's;
	// these are the ones that need page context. The d-pad is shared: the card
	// owns ↑↓ while unanswered (option cursor), the page takes it over once the
	// answer is showing and there's a 詳解 to read — hence `cardRevealed`.
	useGamepad((action) => {
		if (!data || editing || noteEditing) return;

		if (expKeysActive) {
			switch (action) {
				case "faceDown":
					// 詳解預設是糊的(「點擊以顯示詳解」)—— 這顆就是那一下點擊。
					if (!revealedExp) {
						setRevealedExp(true);
						return;
					}
					break;
				case "faceUp":
					// 工具列只在揭曉後才在,所以沒揭曉時這顆不該有反應。
					if (revealedExp && !autoClozeLoading) {
						toggleAutoCloze(data.id, "exp");
						return;
					}
					break;
				case "faceLeft":
					if (revealedExp) {
						setExpCloze((v) => !v);
						return;
					}
					break;
				case "faceRight":
					// 跟「編輯」按鈕自己的停用條件對齊 —— 手把不該繞過鎖。
					if (
						online &&
						lockState.status !== "acquiring" &&
						lockState.status !== "locked-by-other"
					) {
						void startEdit();
						return;
					}
					break;
			}
		}

		if (noteTabVisible) {
			switch (action) {
				case "up":
					if (moveHeading(-1)) return;
					break; // 這則筆記沒有標題 → 落回原本的捲動行為
				case "down":
					if (moveHeading(1)) return;
					break;
				case "faceDown": {
					const items = noteHeadings();
					// 游標還沒開始走(-1)不是「沒東西可展開」,是「從第一個開始」。
					// 原本這裡直接 break,於是剛切到筆記分頁按 FACE ▼ 完全沒反應 ——
					// 而說明列只寫「展開 / 收合這一段」,沒告訴使用者得先用 ↑↓ 選一段。
					// 一顆按下去什麼都不發生的鍵,讀起來就是「這功能在我的手把上壞了」。
					if (headingIdx.current < 0 && items.length > 0)
						headingIdx.current = 0;
					const at = headingIdx.current;
					if (at >= 0 && at < items.length) {
						// click() 不會移動焦點,所以 -1 那條路徑得自己補 —— 少了它,
						// 展開了但游標仍是隱形的,下一顆 ↑↓ 又要重新猜自己在哪。
						items[at].focus();
						items[at].click();
						return;
					}
					break;
				}
				case "left":
				case "right":
					if (notes.length > 1) {
						setNoteSlot(
							nextSlot(
								notes.map((n) => n.slot),
								activeSlot,
								action === "right" ? 1 : -1,
							),
						);
						return;
					}
					break;
			}
		}

		switch (action) {
			case "l1":
				if (navPrev) navigate(`/q/${navPrev}`, { state: location.state });
				break;
			case "r1":
				if (navNext) navigate(`/q/${navNext}`, { state: location.state });
				break;
			case "l2":
				cycleTab(-1);
				break;
			case "r2":
				cycleTab(1);
				break;
			case "start":
				navigate(`/year/${data.year}`);
				break;
			case "up":
				if (cardRevealed) gamepadScrollBy(-GAMEPAD_SCROLL_STEP);
				break;
			case "down":
				if (cardRevealed) gamepadScrollBy(GAMEPAD_SCROLL_STEP);
				break;
		}
	});

	// While we have data, keep rendering even during a refetch — this is the
	// common case after saving 詳解, where blanking the page would feel jarring.
	if (!data) {
		if (error)
			return (
				<div className="p-8 text-center text-rose-700">
					載入失敗:{String(error)}
				</div>
			);
		// 骨架延後 120ms 才出現。預抓沒命中但網路很快時,骨架閃一下再被真內容取代
		// 比直接等更吵 —— 那一下閃爍讀起來像頁面壞掉。撐不過 120ms 的等待,使用者
		// 根本感覺不到;撐過了才值得給回饋。
		// First-load skeleton — same outer dimensions as the loaded layout so
		// the header + question card + tab strip don't jump on hydration.
		return showSkeleton ? <QuestionDetailSkeleton /> : null;
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
		<div
			ref={contentRef}
			className="max-w-3xl md:max-w-none mx-auto px-4 sm:px-6 md:px-4 py-6 sm:py-8 pb-32 md:pb-0"
			style={{ "--nav-h": `${navH}px` } as CSSProperties}
		>
			{/* The header (回年度 / 上下題 / 檢視切換) is sticky on mobile — the page
			    is one long scroll there, and 上一題/下一題 shouldn't scroll away. At
			    ≥md it only stays sticky in tabs mode (riding along with the tab
			    strip in one block); columns mode doesn't scroll the page, so the
			    header drops back into normal flow. The bg + edge-bleed keep
			    scrolled content from showing through the blur. */}
			<div
				ref={navBarRef}
				className={
					// top 吃 --header-h 而不是寫死 top-14:header 帶著頂端安全區,
					// 有瀏海的裝置上 h-14 不等於 header 的高度(見 styles.css)。
					"chrome-follow sticky top-[var(--chrome-top)] z-20 -mx-4 px-4 sm:-mx-6 sm:px-6 pt-3 pb-2 bg-ink-50 dark:bg-ink-900 " +
					(tabsMode
						? "md:-mx-4 md:px-4 md:pb-0 md:mb-6 md:bg-ink-50/95 md:dark:bg-ink-900/95 md:backdrop-blur"
						: "md:static md:mx-0 md:px-0 md:pt-0 md:pb-0 md:bg-transparent md:dark:bg-transparent")
				}
			>
				<header
					className={
						"flex items-center justify-between mb-4 md:mb-6 text-sm gap-3" +
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
								onPointerEnter={() => warm(navPrev)}
								onPointerDown={() => warm(navPrev)}
								onFocus={() => warm(navPrev)}
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
								onPointerEnter={() => warm(navNext)}
								onPointerDown={() => warm(navNext)}
								onFocus={() => warm(navNext)}
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
				{tabsMode &&
					(() => {
						// 分頁列:窄螢幕把尾端摺進 <EllipsisVertical />(同 header 的階梯,
						// 見 CLAUDE.md)。六個分頁在 390px 上必定折行,而這條 strip 是
						// sticky 的 —— 折行等於每次換題都少一行可讀高度。
						//
						// 頭三個(題目/詳解/個人筆記)是每天來回切的,永遠留在列上;
						// 尾端三個(討論串/相似題目/影片)才摺。**目前這一頁一定要在列上**,
						// 即使它屬於尾端 —— 否則從選單挑了「影片」之後,列上沒有一個是亮的。
						const items = [
							{ key: "question" as const, label: "題目" },
							{ key: "explanation" as const, label: "詳解" },
							{
								key: "note" as const,
								label: "個人筆記",
								badge: data.my_note ? (
									<span className="ml-1.5 text-[10px] text-ink-400 dark:text-ink-500">
										●
									</span>
								) : null,
							},
							{
								key: "discussion" as const,
								label: "討論串",
								count: commentCount,
							},
							{
								key: "similar" as const,
								label: "相似題目",
								count: similar.length,
							},
							...(hasVideos
								? [{ key: "video" as const, label: "影片", count: videoCount }]
								: []),
						];
						const HEAD = 3;
						const inline = tabsNarrow
							? items.filter((t, i) => i < HEAD || t.key === mainTab)
							: items;
						const folded = tabsNarrow
							? items.filter((t, i) => i >= HEAD && t.key !== mainTab)
							: [];
						const countOf = (t: (typeof items)[number]) =>
							t.count === undefined ? null : (
								<span className="ml-1.5 text-xs text-ink-400 dark:text-ink-500 font-sans">
									({t.count})
								</span>
							);

						return (
							<div
								className={
									"border-b border-ink-200 dark:border-ink-700 max-w-4xl mx-auto pt-1 pb-0 items-center " +
									// 窄螢幕一律 tabs,所以這條要顯示;≥md 才由 tabsMode 決定。
									(narrow ? "flex" : "hidden md:flex") +
									// 摺疊生效時不准折行 —— 會折的話摺疊就沒有意義了。
									(tabsNarrow ? "" : " flex-wrap")
								}
							>
								{inline.map((t) => (
									<TabButton
										key={t.key}
										active={mainTab === t.key}
										onClick={() => pickTab(t.key)}
									>
										{t.label}
										{"badge" in t ? t.badge : null}
										{countOf(t)}
									</TabButton>
								))}
								<div className="ml-auto">
									<TabOverflowMenu count={folded.length}>
										{folded.map((t) => (
											<TabOverflowItem
												key={t.key}
												onClick={() => pickTab(t.key)}
											>
												{t.label}
												{"badge" in t ? t.badge : null}
												{countOf(t)}
											</TabOverflowItem>
										))}
									</TabOverflowMenu>
								</div>
							</div>
						);
					})()}
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
								(mainTab === "question" ? "" : ` ${mdHidden}`)
							: "md:h-full md:min-w-0 md:shrink-0 md:overflow-y-auto md:overscroll-contain md:pr-1 md:pb-8"
					}
					style={tabsMode ? undefined : { flexBasis: `${splitPct}%` }}
				>
					<QuestionCard
						key={data.id}
						yieldFaceKeys={expKeysActive}
						question={data}
						// 不用 reload:那會強制重抓一份我們已經知道答案的 payload,而在
						// 慢網路上 SW 會拿三秒前的快取回來把剛作答的狀態洗掉(#95)。
						// 見 lib/questionCache.ts 的 withAnswer。
						onAnswered={(chosen, correct) => {
							// 記憶體(setData)給當下的畫面,localStorage 給重載之後 ——
							// 送出成功也要記,因為下次讀回來仍可能是 SW 那份答題前的
							// 快取(NetworkFirst + 3 秒 timeout,存 7 天)。
							recordLocalAnswer(data.id, chosen, correct);
							setData(withAnswer(data, chosen, correct));
						}}
						onProgressCleared={() => {
							// 本地鏡像要一起忘掉,否則下次讀回來又被它救回去。
							forgetLocalAnswer(data.id);
							setData(withProgressCleared(data));
						}}
						onRevealedChange={setCardRevealed}
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
					ref={rightColRef}
					className={
						"tiptap-compact md:mt-0 " +
						// 分頁之後這一欄不再接在題目卡下面,`mt-8` 那道間距就變成標籤列
						// 與內容之間一塊沒來由的空白。
						(narrow ? "" : "mt-8 ") +
						(tabsMode
							? "md:max-w-4xl md:mx-auto md:pb-12" +
								(mainTab === "question" ? ` ${mdHidden}` : "")
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
								? ` ${mdHidden}`
								: "")
						}
					>
						{/* On mobile this pins right under the sticky 年度/上下題 列 (hence
				    the --nav-h offset on top of the h-14 app bar). Columns mode pins
				    it under the pane's own scroll top (md:top-0). Tabs mode has no
				    pane scroller and its own sticky header above, so let this strip
				    (only the OpenEvidence link at ≥md) flow. */}
						<div
							ref={innerStripRef}
							className={
								"chrome-follow sticky top-[calc(var(--chrome-top)+var(--nav-h,0px))] z-10 flex items-center justify-between gap-3 bg-ink-50 dark:bg-ink-900 md:bg-ink-50/95 md:dark:bg-ink-900/95 md:backdrop-blur pt-1 pb-3 " +
								(tabsMode ? "md:static" : "md:top-0")
							}
						>
							<div
								className={
									"flex flex-wrap border-b border-ink-200 dark:border-ink-700" +
									(tabsMode ? ` ${mdHidden}` : "")
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
						<KeepAlive active={tab === "explanation"}>
							{editing ? (
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
							)}
						</KeepAlive>

						{tab === "note" && hasNoteDraft && (
							<p className="mb-2 text-xs text-amber-700 dark:text-amber-400">
								↺ 有未送出的筆記草稿——點「編輯」繼續
							</p>
						)}
						<KeepAlive active={tab === "note"}>
							{noteEditing ? (
								<div className="bg-white dark:bg-ink-800 border-2 border-accent/40 rounded-lg p-4 sm:p-5 shadow-paper">
									<div className="mb-3 flex items-center gap-3 text-xs text-ink-500 dark:text-ink-400">
										<span>✎ 個人筆記 · 僅你可見</span>
										{/* 刪除只在編輯模式出現(#121)—— 唯讀時它跟「編輯」並排,而兩者的
										    後果完全不對等,靠顏色講不夠;要刪得先按編輯。刻意**不**放進
										    RichEditor 的 toolbarActions:那裡緊鄰「儲存」,把刪除擺過去等於
										    用一個更糟的相鄰關係換掉舊的。確認對話框在 removeNote 裡,和切換器
										    下拉的刪除是同一個。 */}
										<button
											type="button"
											onClick={() => removeNote(activeSlot)}
											disabled={notesBusy || noteSaving}
											title="刪除這則筆記"
											className="ml-auto inline-flex items-center gap-1 rounded px-2 py-1 text-ink-400 dark:text-ink-500 transition hover:bg-rose-50 hover:text-rose-600 disabled:opacity-40 dark:hover:bg-rose-900/20 dark:hover:text-rose-400"
										>
											<Trash2 size={13} /> 刪除這則
										</button>
									</div>
									<RichEditor
										content={noteDraft}
										onChange={(j) => {
											setNoteDraft(j);
											saveDraft(noteDraftKey, j);
										}}
										placeholder="寫下你的私人筆記。可貼圖、@114 引用其他題目。"
										autofocus
										onImportAsNotes={importOeAsNotes}
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
								<article
									className={
										"bg-white dark:bg-ink-800 border border-ink-200 dark:border-ink-700 shadow-paper " +
										(noteFullscreen
											? // `relative` 要一起拿掉,不能只是多加一個 `fixed`:兩者
												// specificity 相同,勝負由 Tailwind 產出的順序決定(實測
												// `.relative` 排在後面而贏),class 字串的先後不算數。
												// 卡片自己捲:它是 fixed 的,頁面那條捲軸捲的是後面那些
												// 看不見的東西,靠它捲不到筆記的結尾。
												// 上緣**不留 padding**:那一圈由 sticky 的工具列自己帶。留著的話
												// 工具列黏住的位置會比捲動區頂端低一圈,內文就從那道縫透出來。
												"fixed inset-0 z-50 overflow-y-auto rounded-none px-5 sm:px-7 pb-5 sm:pb-7 " +
												// 滿版的行寬讀起來很糟(見 CLAUDE.md 的閱讀寬度)。
												// 用 [&>*] 把每個直接子元素收在同一條欄寬裡,而不是
												// 再包一層 div —— 包了的話工具列、內文、頁尾、關聯
												// 建議四塊要一起搬,JSX 動的範圍大得多。
												"[&>*]:mx-auto [&>*]:w-full [&>*]:max-w-4xl"
											: "relative rounded-lg p-5 sm:p-7")
									}
								>
									<div
										className={
											// 全螢幕時卡片自己是捲動容器,所以工具列黏在它的 top-0(#122)。
											// 卡片在那個狀態下不留上緣 padding(見上面),改由這裡的 pt 帶 ——
											// 兩者加起來,工具列的 border box 剛好貼齊捲動區頂端,結構上就
											// 沒有縫可以讓內文透出來。用負 margin 去蓋那圈 padding 也做得到,
											// 但實測會留下 29px 的殘縫,而且 `-mx` 會跟卡片的 `[&>*]:mx-auto`
											// 搶同一個屬性(同 specificity,勝負只由 Tailwind 產出順序決定
											// —— #115 那個 relative/fixed 的翻版)。
											//
											// 不能沿用 substick:它的 sticky 偏移量是右欄那條分頁 strip 的高度,
											// 而全螢幕時那條 strip 不在畫面上,照用會把工具列往下推、第一個標題
											// 被壓在它底下(#115 的截圖抓到過)。
											// 全螢幕是 `fixed inset-0 z-50`,蓋在 header 之上 —— 也就是說它
											// 脫離了 header 的 `.safe-top`,頂端安全區得自己帶(#137)。
											// 少了它,加到主畫面的 iPhone 上這條工具列會被動態島壓住。
											// ⚠️ 一般瀏覽器裡看不出差別:inset 是 0,兩者完全一樣。
											(noteFullscreen
												? "sticky top-0 z-10 pt-[calc(1.25rem+env(safe-area-inset-top))] sm:pt-[calc(1.75rem+env(safe-area-inset-top))] pb-2 mb-3 bg-white dark:bg-ink-800 border-b border-ink-100 dark:border-ink-700"
												: tabsMode
													? "mb-3"
													: "substick -mx-5 sm:-mx-7 px-5 sm:px-7 pt-1 pb-2 bg-white dark:bg-ink-800 border-b border-ink-100 dark:border-ink-700") +
											" flex flex-wrap items-center justify-end gap-1.5"
										}
										style={
											// --strip-h 只有 substick 那條路用得到(見上面的 className)。
											tabsMode || noteFullscreen
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
												onReorder={reorderNotes}
											/>
										</div>
										{/* 全螢幕。放在自動挖空之前 —— 這一排右半邊是「怎麼讀這則筆記」
											    (全螢幕 / 自動挖空 / 防劇透),再過去才是會改動內容的編輯與刪除。 */}
										<button
											type="button"
											onClick={() => setNoteFullscreen((v) => !v)}
											title="全螢幕:把這張筆記卡放大到整個視窗,長筆記不必在窄欄裡捲。按 Esc 或再按一次離開"
											aria-pressed={noteFullscreen}
											className={TOOL_BTN(noteFullscreen)}
										>
											{noteFullscreen ? (
												<Shrink size={14} />
											) : (
												<Expand size={14} />
											)}{" "}
											{noteFullscreen ? "離開全螢幕" : "全螢幕"}
										</button>
										{noteAutoMsg && (
											<span className="self-center text-xs text-ink-400 dark:text-ink-500">
												{noteAutoMsg}
											</span>
										)}
										{/* 自動挖空 / 防劇透 / 編輯 —— **只有窄螢幕收進「更多」**(#137)。
										    寬螢幕塞得下就直接畫出來:多一次點擊換來的空白沒有意義,而
										    「編輯」被藏起來最有感。390px 上四顆帶文字的按鈕必定折成兩行,
										    而那一列是 justify-end 的,折行之後「編輯」單獨吊在右下角。
										    兩種形態吃同一份 noteTools —— 各寫一次的話,新加的按鈕遲早只會
										    出現在其中一種寬度下。全螢幕不在這組裡,見 NoteToolsMenu。 */}
										{noteToolsNarrow ? (
											<NoteToolsMenu tools={noteTools} />
										) : (
											<NoteToolButtons tools={noteTools} className={TOOL_BTN} />
										)}
									</div>
									{/* 手把導覽以這個容器為範圍找標題按鈕(見 noteHeadings)。 */}
									<div ref={notePaneRef}>
										<NoteContent
											content={noteJson}
											annotateKeyPrefix={`anno:note:${data.id}`}
											cloze={noteCloze}
											autoTerms={noteAutoTerms ?? undefined}
										/>
									</div>
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

									<NoteLinkList links={noteLinks} />
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
							)}
						</KeepAlive>

						{/* 討論串 —— 這是唯一的入口(下面那份給窄版面的重複區塊已於
				    #96 之後失效並移除)。上面那個 effect 會在視窗變窄、這個分頁
				    不再存在時把 tab 推回 "explanation",所以不會停在一個
				    「選了討論串卻看不到」的狀態。 */}
						<KeepAlive active={tab === "discussion"}>
							<div className={(narrow ? "block" : "hidden md:block") + " mt-2"}>
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
						</KeepAlive>
					</section>

					{/* 策展影片 — 依主題分組。跟 討論串/相似題目 不同,窄螢幕也走 tab
			    (不落在頁面流的底部):影片卡本來就是單欄的,不需要寬版面。
			    基準 class 用 tab(<md 只有內層 strip 生效),md: 再依模式覆寫。 */}
					{hasVideos && (
						<section
							className={
								// 同 相似題目:窄螢幕的顯示交給下面那段(由 mainTab 決定)。
								// `tab` 不會跟著 mainTab 走到 video —— 上面那條同步 effect 只處理
								// explanation/note/discussion,所以留著舊判斷的話 "hidden" 會贏過
								// 後面的 "block"(Tailwind 的 .hidden 排在 .block 之後),影片分頁
								// 就永遠是空白的。
								(narrow ? "" : tab === "video" ? "block" : "hidden") +
								" mt-8 " +
								((tabsMode ? mainTab === "video" : tab === "video")
									? mdBlock
									: mdHidden)
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
							// 窄螢幕的顯示完全交給下面那段(含「尚無相似題目」空狀態,跟桌機
							// 分頁一致);寬螢幕維持原本「有才佔位」的流式版面。
							(narrow ? "" : similar.length > 0 ? "block" : "hidden") +
							((tabsMode ? mainTab === "similar" : tab === "similar")
								? ` ${mdBlock}`
								: ` ${mdHidden}`)
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
									? ` ${mdHidden}`
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

					{/* #96 之前這裡還有第二份 CommentThread,給「雙欄模式的窄版面」用。
			    那個版面已經不存在了:窄螢幕(<md)一律走 tabs,所以 `!tabsMode`
			    就等於 ≥md,而它的 class 是 `md:hidden` —— 兩種情況都看不見。
			    它卻照樣掛載、照樣抓一次留言:量到的是「每個人開任何一題,都在
			    背景抓討論串」,而使用者連分頁都還沒點。上面那條 strip 裡的
			    「討論串」分頁是現在唯一的入口。 */}
				</div>
				{/* /right column */}
			</div>
			{/* /two-column grid */}
			<BackToTopFab />
			<GamepadFab
				hints={
					noteTabVisible
						? GAMEPAD_HINTS_NOTE
						: expKeysActive
							? GAMEPAD_HINTS_EXPLANATION
							: cardRevealed
								? GAMEPAD_HINTS_REVEALED
								: GAMEPAD_HINTS_ANSWERING
				}
			/>
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

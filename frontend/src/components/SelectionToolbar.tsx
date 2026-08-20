import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";
import { useLocation } from "react-router-dom";
import {
	BookOpen,
	Check,
	Highlighter,
	Loader2,
	Send,
	Sparkles,
	X as XIcon,
} from "lucide-react";
import { useTextSelection, type TextSelection } from "../lib/useTextSelection";
import { blockContext, selectionActions } from "../lib/selectionActions";
import { sendSelectionToTelegram, useTgLinked } from "../lib/telegramApi";
import {
	useAnnotationRegistry,
	type AnnotationTarget,
	type MarkRequest,
} from "./AnnotationRegistry";
import { ReferencePanel } from "./selection/ReferencePanel";
import { AiPanel } from "./selection/AiPanel";

// 全站唯一的選字工具列。
//
// 在此之前有兩個各自為政的浮層:AnnotatableContent 內嵌的「螢光標記」小 popup,
// 和 App 層的「查參考資料」badge。選字落在詳解裡時兩個會同時冒出來。現在是一
// 張卡片、一列按鈕,展開區往下長。
//
// 四顆按鈕按情境亮(見 lib/selectionActions.ts)——「螢光標記」需要選取落在某個
// 已註冊的 AnnotatableContent 裡,靠 AnnotationRegistry 反查;「存到 Telegram」
// 需要已綁定帳號且在題目頁(訊息要帶題目出處)。

const PANEL_W = 360;
/** 卡片與選取之間、以及卡片與視窗邊緣之間的留白。 */
const GAP = 8;
/** 展開時偏好往下開所需的最小空間;不足才考慮翻上去。 */
const PREFER_BELOW = 280;

// 工具列的來源:一段新選取,或是點擊了既有的黃色標記。
type Anchor = {
	text: string;
	/** 保留段落結構的版本,只有「原樣帶走」的動作該用(存到 Telegram)。
	 * 來源是畫記時沒有原始選取可回溯,退回 `text`。 */
	rawText: string;
	rect: DOMRect;
	/**
	 * 重新量測錨點在視窗中的位置。捲動時工具列靠它跟著選取一起走 ——
	 * `rect` 只是產生當下的快照。錨點已從 DOM 消失時回 null。
	 */
	measure: () => DOMRect | null;
	/** AI 的 {{context}} 從這個節點往上找最近的區塊。mark 來源時為 null。 */
	contextNode: Node | null;
	highlight:
		| { kind: "add" | "clear"; target: AnnotationTarget; from: number; to: number }
		| null;
};

function usable(r: DOMRect | null): DOMRect | null {
	return r && (r.width > 0 || r.height > 0) ? r : null;
}

export function SelectionToolbar() {
	const { selection, clear } = useTextSelection();
	const registry = useAnnotationRegistry();
	const [mark, setMark] = useState<MarkRequest | null>(null);
	// 綁定狀態在這裡查(整個 app 只掛一個 SelectionToolbar),而不是在每次選取
	// 重建的 Toolbar 裡 —— 否則按鈕會在卡片已經畫出來之後才冒出來,把游標正要
	// 按的那顆按鈕推走。
	const tgLinked = useTgLinked();

	// 點 mark 與拉選取是互斥的兩種來源:後到的取代先到的。
	useEffect(
		() =>
			registry.onMark((req) => {
				clear();
				setMark(req);
			}),
		[registry, clear],
	);

	const anchor = useMemo<Anchor | null>(() => {
		if (mark) {
			return {
				text: mark.text,
				rawText: mark.text,
				rect: mark.rect,
				measure: () =>
					mark.el.isConnected ? mark.el.getBoundingClientRect() : null,
				contextNode: null,
				highlight: {
					kind: "clear",
					target: mark.target,
					from: mark.from,
					to: mark.to,
				},
			};
		}
		if (selection) return anchorFromSelection(selection, registry.find);
		return null;
	}, [mark, selection, registry.find]);

	const dismiss = useCallback(() => {
		setMark(null);
		clear();
	}, [clear]);

	if (!anchor) return null;
	return (
		<Toolbar
			// 每個新的選取/標記都要一張全新的卡片,否則上一次的展開狀態
			// (串到一半的 AI 回答)會被下一段選取繼承。
			key={`${anchor.rect.top}:${anchor.rect.left}:${anchor.text.slice(0, 24)}`}
			anchor={anchor}
			tgLinked={tgLinked}
			onDismiss={dismiss}
		/>
	);
}

// 把一段選取轉成 anchor,順便算出它能不能畫記。
function anchorFromSelection(
	sel: TextSelection,
	find: (node: Node | null) => AnnotationTarget | null,
): Anchor {
	const target = find(sel.node);
	let highlight: Anchor["highlight"] = null;

	if (target && !target.cloze && sel.anchorNode && sel.focusNode) {
		const a = target.posAt(sel.anchorNode, sel.anchorOffset);
		const b = target.posAt(sel.focusNode, sel.focusOffset);
		if (a != null && b != null) {
			const from = Math.min(a, b);
			const to = Math.max(a, b);
			if (to > from) highlight = { kind: "add", target, from, to };
		}
	}

	return {
		text: sel.text,
		rawText: sel.rawText,
		rect: sel.rect,
		// Range 在文件裡的節點被換掉時會退化成寬高 0(例如詳解重新 render),
		// usable() 會把那種結果當成「量不到」,工具列就收起來。
		measure: () => sel.range.getBoundingClientRect(),
		contextNode: sel.node,
		highlight,
	};
}

type Mode = "idle" | "reference" | "ai";

function Toolbar({
	anchor,
	tgLinked,
	onDismiss,
}: {
	anchor: Anchor;
	tgLinked: boolean;
	onDismiss: () => void;
}) {
	const [mode, setMode] = useState<Mode>("idle");
	const rootRef = useRef<HTMLDivElement>(null);
	const location = useLocation();

	const expanded = mode !== "idle";

	// 「存到筆記」只在題目頁有意義。工具列掛在 Routes 外面,拿不到 useParams,
	// 所以直接讀路徑。
	const questionId = useMemo(() => {
		const m = /^\/q\/([^/?#]+)/.exec(location.pathname);
		return m ? decodeURIComponent(m[1]) : null;
	}, [location.pathname]);

	const actions = selectionActions({
		text: anchor.text,
		inAnnotatable: anchor.highlight != null,
		// cloze 已在 anchorFromSelection 判掉(cloze 時不產生 highlight),
		// 這裡傳 false 即可。
		cloze: false,
		onQuestionPage: questionId != null,
		telegramLinked: tgLinked,
	});
	const clearing = anchor.highlight?.kind === "clear";

	// 錨點在視窗中的當下位置。捲動時重新量測,卡片才會跟著被選取的那段文字走
	// —— 從前這裡是一次性的快照,展開狀態捲一下卡片就跟正文脫節了。
	const [rect, setRect] = useState<DOMRect>(anchor.rect);

	const [tg, setTg] = useState<"idle" | "sending" | "done" | "error">("idle");
	const doneTimer = useRef<number | undefined>(undefined);
	useEffect(() => () => window.clearTimeout(doneTimer.current), []);

	// 收合時的實際寬度。按鈕數會變(四顆全亮時比兩顆寬一倍),所以量出來再拿去
	// 夾 left —— 沿用寫死的估計值時,靠視窗右緣的選取會把卡片推出畫面外。
	const [collapsedW, setCollapsedW] = useState(240);
	useLayoutEffect(() => {
		if (expanded) return;
		const w = rootRef.current?.offsetWidth;
		if (w) setCollapsedW(w);
	}, [expanded, actions.highlight, actions.lookup, actions.telegram]);

	// Esc 關閉;外點關閉;捲動跟著走,錨點捲出視窗才關。
	useEffect(() => {
		function onKey(e: KeyboardEvent) {
			if (e.key === "Escape") onDismiss();
		}
		let raf = 0;
		function reposition() {
			cancelAnimationFrame(raf);
			raf = requestAnimationFrame(() => {
				const r = usable(anchor.measure());
				// 量不到(節點沒了)或整段被捲出視窗 —— 留著只會是一張漂在
				// 無關內容上的孤兒卡片。
				if (!r || r.bottom < 0 || r.top > window.innerHeight) {
					onDismiss();
					return;
				}
				setRect(r);
			});
		}
		function onDown(e: MouseEvent) {
			if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
				onDismiss();
			}
		}
		document.addEventListener("keydown", onKey);
		// capture:內層捲動容器(欄位模式的詳解 pane)的 scroll 不會冒泡。
		window.addEventListener("scroll", reposition, true);
		window.addEventListener("resize", reposition);
		// 下一個 tick 才掛:製造這次選取的那個 mouseup 不該立刻把卡片關掉。
		const t = window.setTimeout(
			() => document.addEventListener("mousedown", onDown),
			0,
		);
		return () => {
			window.clearTimeout(t);
			cancelAnimationFrame(raf);
			document.removeEventListener("keydown", onKey);
			window.removeEventListener("scroll", reposition, true);
			window.removeEventListener("resize", reposition);
			document.removeEventListener("mousedown", onDown);
		};
	}, [onDismiss, anchor]);

	function doHighlight() {
		const h = anchor.highlight;
		if (!h) return;
		if (h.kind === "add") h.target.applyHighlight(h.from, h.to);
		else h.target.clearHighlight(h.from, h.to);
		window.getSelection()?.removeAllRanges();
		onDismiss();
	}

	// 「存到 Telegram」是一鍵動作(不展開面板),所以成敗只能靠按鈕自己的文字
	// 回報;成功後停一下讓人看到「已送出」再收卡片。失敗後可以再按一次 ——
	// 常見的失敗是連線斷了,重試就好。
	async function doSendTelegram() {
		if (!questionId || tg === "sending" || tg === "done") return;
		setTg("sending");
		try {
			await sendSelectionToTelegram(anchor.rawText, questionId);
			setTg("done");
			doneTimer.current = window.setTimeout(onDismiss, 1200);
		} catch {
			setTg("error");
		}
	}

	// 定位:固定座標,預設在選取下方;下方塞不下且上方更寬敞才翻上去。
	//
	// 高度上限一律由「那一側實際剩下多少」決定,不用固定的 vh —— LLM 的回答
	// 長度沒有上限,寫死高度時卡片會從視窗底部長出去,而 fixed 定位的元素沒有
	// 頁面捲動可以救,尾巴就永遠讀不到。上限傳給卡片,內容自己捲。
	const width = expanded ? PANEL_W : undefined;
	const left = Math.min(
		Math.max(GAP, rect.left),
		Math.max(GAP, window.innerWidth - (width ?? collapsedW) - GAP),
	);
	const below = window.innerHeight - rect.bottom - GAP * 2;
	const above = rect.top - GAP * 2;
	const openUp = expanded && below < Math.min(PREFER_BELOW, above);
	const style: React.CSSProperties = {
		position: "fixed",
		left,
		zIndex: 60,
		...(width ? { width } : {}),
		...(openUp
			? { bottom: window.innerHeight - rect.top + GAP }
			: { top: rect.bottom + GAP }),
	};

	return createPortal(
		<div
			ref={rootRef}
			data-selection-toolbar
			style={style}
			onMouseDown={(e) => e.stopPropagation()}
		>
			<div
				className="flex flex-col rounded-xl border border-ink-200 dark:border-ink-700 bg-white dark:bg-ink-800 shadow-xl overflow-hidden"
				// 收合狀態只有一列按鈕,不需要高度上限(也不該被裁掉);但寬度要吃
				// 得住視窗 —— 四顆按鈕在手機上放不進一列,靠 flex-wrap 折成兩列。
				style={
					expanded
						? { maxHeight: Math.max(140, openUp ? above : below) }
						: { maxWidth: window.innerWidth - GAP * 2 }
				}
			>
				{/* 動作列 —— 一列,分隔線,同一個外框 */}
				<div className="shrink-0 flex flex-wrap items-stretch divide-x divide-ink-100 dark:divide-ink-700">
					{actions.highlight && (
						<ToolButton
							active={false}
							onClick={doHighlight}
							icon={
								clearing ? <XIcon size={13} /> : <Highlighter size={13} />
							}
							label={clearing ? "清除標記" : "螢光標記"}
							hover={
								clearing
									? "hover:bg-rose-50 dark:hover:bg-rose-500/15"
									: "hover:bg-yellow-50 dark:hover:bg-yellow-400/15"
							}
						/>
					)}
					{actions.lookup && (
						<ToolButton
							active={mode === "reference"}
							onClick={() =>
								setMode((m) => (m === "reference" ? "idle" : "reference"))
							}
							icon={<BookOpen size={13} />}
							label="查參考資料"
							hover="hover:bg-sky-50 dark:hover:bg-sky-400/15"
						/>
					)}
					{actions.ai && (
						<ToolButton
							active={mode === "ai"}
							onClick={() => setMode((m) => (m === "ai" ? "idle" : "ai"))}
							icon={<Sparkles size={13} />}
							label="AI"
							hover="hover:bg-violet-50 dark:hover:bg-violet-400/15"
						/>
					)}
					{actions.telegram && (
						<ToolButton
							active={false}
							onClick={doSendTelegram}
							icon={
								tg === "sending" ? (
									<Loader2 size={13} className="animate-spin" />
								) : tg === "done" ? (
									<Check size={13} />
								) : (
									<Send size={13} />
								)
							}
							label={
								tg === "done"
									? "已送出"
									: tg === "error"
										? "傳送失敗"
										: "存到 Telegram"
							}
							hover="hover:bg-cyan-50 dark:hover:bg-cyan-400/15"
						/>
					)}
				</div>

				{/* 展開區 —— 在同一張卡片裡往下長,不是第二個浮層。
				    min-h-0 是讓面板吃得到 flex 剩餘高度的關鍵(否則內容會把
				    flex item 撐開,maxHeight 形同虛設)。 */}
				{mode === "reference" && (
					<div className="min-h-0 flex flex-col border-t border-ink-100 dark:border-ink-700">
						<ReferencePanel text={anchor.text} onNavigate={onDismiss} />
					</div>
				)}
				{mode === "ai" && (
					<div className="min-h-0 flex flex-col border-t border-ink-100 dark:border-ink-700">
						<AiPanel
							selection={anchor.text}
							context={blockContext(anchor.contextNode, anchor.text)}
							questionId={questionId}
						/>
					</div>
				)}
			</div>
		</div>,
		document.body,
	);
}

function ToolButton({
	active,
	onClick,
	icon,
	label,
	hover,
}: {
	active: boolean;
	onClick: () => void;
	icon: React.ReactNode;
	label: string;
	hover: string;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			className={[
				"flex-1 inline-flex items-center justify-center gap-1.5 whitespace-nowrap",
				"px-3 py-2 text-xs font-medium transition",
				active
					? "bg-ink-100 dark:bg-ink-700 text-ink-900 dark:text-ink-100"
					: `text-ink-700 dark:text-ink-200 ${hover}`,
			].join(" ")}
		>
			{icon}
			{label}
		</button>
	);
}

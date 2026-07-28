import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLocation } from "react-router-dom";
import { BookOpen, Highlighter, Sparkles, X as XIcon } from "lucide-react";
import { useTextSelection, type TextSelection } from "../lib/useTextSelection";
import { blockContext, selectionActions } from "../lib/selectionActions";
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
// 三顆按鈕按情境亮(見 lib/selectionActions.ts)——「螢光標記」需要選取落在某個
// 已註冊的 AnnotatableContent 裡,靠 AnnotationRegistry 反查。

const PANEL_W = 360;

// 工具列的來源:一段新選取,或是點擊了既有的黃色標記。
type Anchor = {
	text: string;
	rect: DOMRect;
	/** AI 的 {{context}} 從這個節點往上找最近的區塊。mark 來源時為 null。 */
	contextNode: Node | null;
	highlight:
		| { kind: "add" | "clear"; target: AnnotationTarget; from: number; to: number }
		| null;
};

export function SelectionToolbar() {
	const { selection, clear } = useTextSelection();
	const registry = useAnnotationRegistry();
	const [mark, setMark] = useState<MarkRequest | null>(null);

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
				rect: mark.rect,
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
		rect: sel.rect,
		contextNode: sel.node,
		highlight,
	};
}

type Mode = "idle" | "reference" | "ai";

function Toolbar({
	anchor,
	onDismiss,
}: {
	anchor: Anchor;
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
	});
	const clearing = anchor.highlight?.kind === "clear";

	// Esc 關閉;外點關閉。捲動只在收合狀態關閉 —— 展開時使用者正在讀結果,
	// 捲一下就消失會讓長回答根本讀不完。
	useEffect(() => {
		function onKey(e: KeyboardEvent) {
			if (e.key === "Escape") onDismiss();
		}
		function onScroll() {
			if (!expanded) onDismiss();
		}
		function onDown(e: MouseEvent) {
			if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
				onDismiss();
			}
		}
		document.addEventListener("keydown", onKey);
		window.addEventListener("scroll", onScroll, true);
		window.addEventListener("resize", onScroll);
		// 下一個 tick 才掛:製造這次選取的那個 mouseup 不該立刻把卡片關掉。
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
	}, [onDismiss, expanded]);

	function doHighlight() {
		const h = anchor.highlight;
		if (!h) return;
		if (h.kind === "add") h.target.applyHighlight(h.from, h.to);
		else h.target.clearHighlight(h.from, h.to);
		window.getSelection()?.removeAllRanges();
		onDismiss();
	}

	// 定位:固定座標,預設在選取下方;展開後若下方塞不下就翻到上方。
	const rect = anchor.rect;
	const width = expanded ? PANEL_W : undefined;
	const left = Math.min(
		Math.max(8, rect.left),
		Math.max(8, window.innerWidth - (width ?? 240) - 8),
	);
	const openUp = expanded && rect.bottom + 320 > window.innerHeight && rect.top > 340;
	const style: React.CSSProperties = {
		position: "fixed",
		left,
		zIndex: 60,
		...(width ? { width } : {}),
		...(openUp
			? { bottom: window.innerHeight - rect.top + 8 }
			: { top: rect.bottom + 8 }),
	};

	return createPortal(
		<div
			ref={rootRef}
			data-selection-toolbar
			style={style}
			onMouseDown={(e) => e.stopPropagation()}
		>
			<div className="rounded-xl border border-ink-200 dark:border-ink-700 bg-white dark:bg-ink-800 shadow-xl overflow-hidden">
				{/* 動作列 —— 一列,分隔線,同一個外框 */}
				<div className="flex items-stretch divide-x divide-ink-100 dark:divide-ink-700">
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
				</div>

				{/* 展開區 —— 在同一張卡片裡往下長,不是第二個浮層 */}
				{mode === "reference" && (
					<div className="border-t border-ink-100 dark:border-ink-700">
						<ReferencePanel text={anchor.text} onNavigate={onDismiss} />
					</div>
				)}
				{mode === "ai" && (
					<div className="border-t border-ink-100 dark:border-ink-700">
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

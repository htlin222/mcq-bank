// Sticky reader toolbar: page nav + indicator, zoom, highlight toggle,
// snapshot, and the side-panel toggle. Scholarly ink/cream styling to match
// the rest of the app — no SaaS gradients.
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
	ChevronLeft,
	ChevronRight,
	ZoomIn,
	ZoomOut,
	RulerDimensionLine,
	Hand,
	Highlighter,
	Bookmark,
	Camera,
	Expand,
	Minimize,
	PanelRight,
	PanelLeft,
} from "lucide-react";

export interface ReaderToolbarProps {
	currentPage: number; // 0-based
	pageCount: number;
	highlightActive: boolean;
	/** Hand/pan (drag-to-scroll) tool active. */
	panActive: boolean;
	panelOpen: boolean;
	thumbnailsOpen: boolean;
	onToggleThumbnails(): void;
	onPrev(): void;
	onNext(): void;
	/** Jump to a 0-based page (from typing in the page indicator). */
	onGoToPage(page: number): void;
	onZoomIn(): void;
	onZoomOut(): void;
	onZoomFit(): void;
	onTogglePan(): void;
	onToggleHighlight(): void;
	/** 現在這一頁已經加了書籤 —— 那顆鈕是 toggle,不是「再加一次」。 */
	bookmarked: boolean;
	onToggleBookmark(): void;
	onSnapshot(): void;
	/** Whole-reader fullscreen (header + toolbar auto-hide). */
	fullscreen: boolean;
	onToggleFullscreen(): void;
	onTogglePanel(): void;
	/** Textbook (唯讀參考書): hide the highlight tool + notebook panel toggle. */
	readOnly?: boolean;
}

export function ReaderToolbar(props: ReaderToolbarProps) {
	const atStart = props.currentPage <= 0;
	const atEnd = props.pageCount > 0 && props.currentPage >= props.pageCount - 1;

	return (
		<div className="sticky top-0 z-20 flex items-center gap-1 border-b border-ink-200 dark:border-ink-700 bg-ink-50/95 dark:bg-ink-900/95 px-2 py-1.5 backdrop-blur sm:gap-2 sm:px-3">
			{/* Thumbnail rail toggle (desktop) */}
			<TBtn
				label="頁面縮圖"
				onClick={props.onToggleThumbnails}
				active={props.thumbnailsOpen}
			>
				<PanelLeft size={17} />
			</TBtn>

			<Divider />

			{/* Page nav */}
			<TBtn label="上一頁 (U / ←)" onClick={props.onPrev} disabled={atStart}>
				<ChevronLeft size={18} />
			</TBtn>
			<PageIndicator
				currentPage={props.currentPage}
				pageCount={props.pageCount}
				onGoToPage={props.onGoToPage}
			/>
			<TBtn label="下一頁 (D / →)" onClick={props.onNext} disabled={atEnd}>
				<ChevronRight size={18} />
			</TBtn>

			<Divider />

			{/* Zoom */}
			<TBtn label="縮小 (-)" onClick={props.onZoomOut}>
				<ZoomOut size={17} />
			</TBtn>
			<TBtn label="放大 (+)" onClick={props.onZoomIn}>
				<ZoomIn size={17} />
			</TBtn>
			<TBtn label="符合寬度" onClick={props.onZoomFit}>
				<RulerDimensionLine size={17} />
			</TBtn>

			<Divider />

			{/* Hand / pan tool — drag to scroll. Navigation only, so it stays
			    available even for 唯讀 textbooks. */}
			<TBtn
				label="手掌工具 (H)"
				onClick={props.onTogglePan}
				active={props.panActive}
			>
				<Hand size={17} />
			</TBtn>

			{/* Highlight tool toggle — write affordance, hidden for 唯讀 textbooks */}
			{!props.readOnly && (
				<TBtn
					label="螢光筆"
					onClick={props.onToggleHighlight}
					active={props.highlightActive}
				>
					<Highlighter size={17} />
				</TBtn>
			)}

			{/* 書籤 — 對「這一頁」的動作,所以跟截圖放在一起,不跟左邊那顆
			    rail 開關混在一起(那顆管的是版面)。唯讀教科書不給加。
			    label 隨狀態換:按下去沒反應的鍵最傷,而一顆永遠寫著「加入書籤」
			    的鈕在已加過的頁面上,按下去看起來就是沒反應。 */}
			{!props.readOnly && (
				<TBtn
					label={props.bookmarked ? "移除書籤 (B)" : "加入書籤 (B)"}
					onClick={props.onToggleBookmark}
					active={props.bookmarked}
				>
					<Bookmark
						size={17}
						fill={props.bookmarked ? "currentColor" : "none"}
					/>
				</TBtn>
			)}

			{/* Snapshot */}
			<TBtn label="截圖" onClick={props.onSnapshot}>
				<Camera size={17} />
			</TBtn>

			{/* Fullscreen — hides header + toolbar; toolbar slides back down when
			    the pointer nears the top edge. */}
			<TBtn
				label={props.fullscreen ? "離開全螢幕 (F / Esc)" : "全螢幕 (F)"}
				onClick={props.onToggleFullscreen}
				active={props.fullscreen}
			>
				{props.fullscreen ? <Minimize size={17} /> : <Expand size={17} />}
			</TBtn>

			<span className="flex-1" />

			{/* Panel toggle — the notebook is meaningless for a 唯讀 reference book */}
			{!props.readOnly && (
				<TBtn
					label="筆記面板"
					onClick={props.onTogglePanel}
					active={props.panelOpen}
				>
					<PanelRight size={17} />
				</TBtn>
			)}
		</div>
	);
}

// Click to type a page number (digits only); Enter jumps, Esc/blur cancels.
function PageIndicator({
	currentPage,
	pageCount,
	onGoToPage,
}: {
	currentPage: number;
	pageCount: number;
	onGoToPage(page: number): void;
}) {
	const [editing, setEditing] = useState(false);
	const [val, setVal] = useState("");
	const inputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		if (editing) {
			setVal(String(currentPage + 1));
			// select after the value is set
			requestAnimationFrame(() => inputRef.current?.select());
		}
	}, [editing, currentPage]);

	function commit() {
		const n = parseInt(val, 10);
		if (!Number.isNaN(n) && n >= 1 && pageCount > 0 && n <= pageCount) {
			onGoToPage(n - 1);
		}
		setEditing(false);
	}

	if (editing) {
		return (
			<span className="whitespace-nowrap px-1 font-mono text-xs text-ink-600 dark:text-ink-300 sm:text-sm">
				p.
				<input
					ref={inputRef}
					type="text"
					inputMode="numeric"
					value={val}
					onChange={(e) => setVal(e.target.value.replace(/[^0-9]/g, ""))}
					onKeyDown={(e) => {
						if (e.key === "Enter") commit();
						else if (e.key === "Escape") setEditing(false);
					}}
					onBlur={() => setEditing(false)}
					aria-label="跳到頁面"
					className="w-10 rounded border border-accent bg-white px-1 py-0.5 text-center text-ink-900 outline-none dark:bg-ink-900 dark:text-ink-100"
				/>
				<span className="text-ink-400 dark:text-ink-500">
					{" "}
					/ {pageCount || "—"}
				</span>
			</span>
		);
	}

	return (
		<button
			type="button"
			onClick={() => setEditing(true)}
			title="點擊輸入頁碼跳頁"
			className="whitespace-nowrap rounded px-1 font-mono text-xs text-ink-600 transition hover:bg-ink-100 hover:text-accent dark:text-ink-300 dark:hover:bg-ink-700 sm:text-sm"
		>
			p.{currentPage + 1}
			<span className="text-ink-400 dark:text-ink-500">
				{" "}
				/ {pageCount || "—"}
			</span>
		</button>
	);
}

function TBtn({
	label,
	onClick,
	disabled,
	active,
	children,
}: {
	label: string;
	onClick(): void;
	disabled?: boolean;
	active?: boolean;
	children: ReactNode;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			disabled={disabled}
			aria-label={label}
			aria-pressed={active}
			title={label}
			className={
				"inline-flex h-8 w-8 items-center justify-center rounded transition " +
				(disabled
					? "cursor-not-allowed text-ink-300 dark:text-ink-600"
					: active
						? "bg-accent/15 text-accent"
						: "text-ink-600 hover:bg-ink-100 hover:text-ink-900 dark:text-ink-300 dark:hover:bg-ink-700 dark:hover:text-ink-100")
			}
		>
			{children}
		</button>
	);
}

function Divider() {
	return (
		<span
			className="mx-0.5 hidden h-5 w-px self-center bg-ink-200 dark:bg-ink-700 sm:mx-1 sm:inline-block"
			aria-hidden="true"
		/>
	);
}

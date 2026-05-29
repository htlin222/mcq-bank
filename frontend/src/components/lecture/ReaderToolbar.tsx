// Sticky reader toolbar: page nav + indicator, zoom, highlight toggle,
// snapshot, and the side-panel toggle. Scholarly ink/cream styling to match
// the rest of the app — no SaaS gradients.
import type { ReactNode } from "react";
import {
	ChevronLeft,
	ChevronRight,
	ZoomIn,
	ZoomOut,
	Maximize,
	Highlighter,
	Camera,
	PanelRight,
} from "lucide-react";

export interface ReaderToolbarProps {
	currentPage: number; // 0-based
	pageCount: number;
	highlightActive: boolean;
	panelOpen: boolean;
	onPrev(): void;
	onNext(): void;
	onZoomIn(): void;
	onZoomOut(): void;
	onZoomFit(): void;
	onToggleHighlight(): void;
	onSnapshot(): void;
	onTogglePanel(): void;
}

export function ReaderToolbar(props: ReaderToolbarProps) {
	const atStart = props.currentPage <= 0;
	const atEnd = props.pageCount > 0 && props.currentPage >= props.pageCount - 1;

	return (
		<div className="sticky top-0 z-20 flex items-center gap-1 border-b border-ink-200 dark:border-ink-700 bg-ink-50/95 dark:bg-ink-900/95 px-2 py-1.5 backdrop-blur sm:gap-2 sm:px-3">
			{/* Page nav */}
			<TBtn label="上一頁" onClick={props.onPrev} disabled={atStart}>
				<ChevronLeft size={18} />
			</TBtn>
			<span className="select-none whitespace-nowrap px-1 font-mono text-xs text-ink-600 dark:text-ink-300 sm:text-sm">
				p.{props.currentPage + 1}
				<span className="text-ink-400 dark:text-ink-500">
					{" "}
					/ {props.pageCount || "—"}
				</span>
			</span>
			<TBtn label="下一頁" onClick={props.onNext} disabled={atEnd}>
				<ChevronRight size={18} />
			</TBtn>

			<Divider />

			{/* Zoom */}
			<TBtn label="縮小" onClick={props.onZoomOut}>
				<ZoomOut size={17} />
			</TBtn>
			<TBtn label="放大" onClick={props.onZoomIn}>
				<ZoomIn size={17} />
			</TBtn>
			<TBtn label="符合寬度" onClick={props.onZoomFit}>
				<Maximize size={16} />
			</TBtn>

			<Divider />

			{/* Highlight tool toggle */}
			<TBtn
				label="螢光筆"
				onClick={props.onToggleHighlight}
				active={props.highlightActive}
			>
				<Highlighter size={17} />
			</TBtn>

			{/* Snapshot */}
			<TBtn label="截圖" onClick={props.onSnapshot}>
				<Camera size={17} />
			</TBtn>

			<span className="flex-1" />

			{/* Panel toggle */}
			<TBtn
				label="筆記面板"
				onClick={props.onTogglePanel}
				active={props.panelOpen}
			>
				<PanelRight size={17} />
			</TBtn>
		</div>
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

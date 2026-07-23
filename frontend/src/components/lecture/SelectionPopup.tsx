// Floating popup anchored at the pointer-up location (NOT the page-coord
// selection rect — see the EmbedPDFViewer contract). Offers four actions on a
// text selection: 螢光標記 / AI 解釋 / OpenEvidence / 複製到筆記.
//
// The AI 解釋 result renders inline (scrollable) so the user can read it without
// leaving the slide. Dismiss on Esc, outside-click, or when the selection clears
// (the reader unmounts this component in that case).
import { useEffect, useRef, useState } from "react";
import {
	Highlighter,
	Sparkles,
	ExternalLink,
	NotebookPen,
	Copy,
	X as XIcon,
} from "lucide-react";
import type { ViewerSelection } from "./EmbedPDFViewer";
import { explainSelection } from "../../lib/lectureApi";
import { buildOpenEvidenceUrlFromText } from "../../lib/openevidence";

export interface SelectionPopupProps {
	/** Pointer-up location in client (viewport) pixels. */
	anchor: { x: number; y: number };
	selection: ViewerSelection;
	/** 0-based page the selection sits on (for 複製到筆記). */
	currentPage: number;
	onHighlight(): void;
	onCopyToNote(text: string, page: number): void;
	/** Yank the raw selected text to the clipboard. */
	onCopyText(text: string): void;
	onDismiss(): void;
	/** Textbook (唯讀): hide 螢光標記 + 複製到筆記 (persisting write actions). */
	readOnly?: boolean;
}

const POPUP_W = 288; // matches w-72

export function SelectionPopup({
	anchor,
	selection,
	currentPage,
	onHighlight,
	onCopyToNote,
	onCopyText,
	onDismiss,
	readOnly,
}: SelectionPopupProps) {
	const ref = useRef<HTMLDivElement>(null);
	const [aiBusy, setAiBusy] = useState(false);
	const [aiText, setAiText] = useState<string | null>(null);
	const [aiError, setAiError] = useState<string | null>(null);

	// Dismiss on Esc + outside-click.
	useEffect(() => {
		function onKey(e: KeyboardEvent) {
			if (e.key === "Escape") onDismiss();
		}
		function onDown(e: MouseEvent) {
			if (ref.current && !ref.current.contains(e.target as Node)) onDismiss();
		}
		document.addEventListener("keydown", onKey);
		// Defer to the next tick so the pointer-up that opened us doesn't also close us.
		const t = setTimeout(() => document.addEventListener("mousedown", onDown), 0);
		return () => {
			document.removeEventListener("keydown", onKey);
			document.removeEventListener("mousedown", onDown);
			clearTimeout(t);
		};
	}, [onDismiss]);

	// Clamp horizontally to the viewport; bias the popup below the pointer, but
	// flip above if it would overflow the bottom.
	const left = Math.min(
		Math.max(8, anchor.x - POPUP_W / 2),
		window.innerWidth - POPUP_W - 8,
	);
	const belowTop = anchor.y + 12;
	const flipUp = belowTop + 240 > window.innerHeight;
	const style: React.CSSProperties = flipUp
		? { left, bottom: window.innerHeight - anchor.y + 12 }
		: { left, top: belowTop };

	async function runExplain() {
		if (aiBusy) return;
		setAiBusy(true);
		setAiError(null);
		setAiText(null);
		try {
			const r = await explainSelection(selection.text);
			setAiText(r.text || "(無回應)");
		} catch (e) {
			setAiError(e instanceof Error ? e.message : String(e));
		} finally {
			setAiBusy(false);
		}
	}

	function openOpenEvidence() {
		window.open(
			buildOpenEvidenceUrlFromText(selection.text),
			"_blank",
			"noopener",
		);
	}

	return (
		<div
			ref={ref}
			role="dialog"
			style={{ position: "fixed", ...style }}
			className="z-40 w-72 animate-fade-in rounded-lg border border-ink-200 bg-white shadow-paper dark:border-ink-700 dark:bg-ink-800"
		>
			<div className="flex items-center justify-between border-b border-ink-100 px-2 py-1.5 dark:border-ink-700">
				<span className="truncate px-1 text-xs text-ink-400 dark:text-ink-500" title={selection.text}>
					「{selection.text.slice(0, 28)}
					{selection.text.length > 28 ? "…" : ""}」
				</span>
				<button
					type="button"
					onClick={onDismiss}
					aria-label="關閉"
					className="text-ink-400 hover:text-ink-700 dark:text-ink-500 dark:hover:text-ink-200"
				>
					<XIcon size={14} />
				</button>
			</div>

			<div className="flex flex-wrap gap-1 p-1.5">
				<Action
					icon={<Copy size={14} />}
					label="複製"
					onClick={() => onCopyText(selection.text)}
				/>
				{!readOnly && (
					<Action icon={<Highlighter size={14} />} label="螢光標記" onClick={onHighlight} />
				)}
				<Action
					icon={<Sparkles size={14} />}
					label={aiBusy ? "解釋中…" : "AI 解釋"}
					onClick={runExplain}
					disabled={aiBusy}
				/>
				<Action
					icon={<ExternalLink size={14} />}
					label="OpenEvidence"
					onClick={openOpenEvidence}
				/>
				{!readOnly && (
					<Action
						icon={<NotebookPen size={14} />}
						label="複製到筆記"
						onClick={() => onCopyToNote(selection.text, currentPage)}
					/>
				)}
			</div>

			{(aiBusy || aiText || aiError) && (
				<div className="max-h-56 overflow-auto border-t border-ink-100 px-3 py-2 text-sm leading-relaxed dark:border-ink-700">
					{aiBusy ? (
						<p className="inline-flex items-center gap-2 text-ink-400 dark:text-ink-500">
							<Sparkles size={13} className="animate-pulse" /> AI 思考中…
						</p>
					) : aiError ? (
						<p className="text-rose-600 dark:text-rose-400">{aiError}</p>
					) : (
						<p className="whitespace-pre-wrap text-ink-800 dark:text-ink-200">
							{aiText}
						</p>
					)}
				</div>
			)}
		</div>
	);
}

function Action({
	icon,
	label,
	onClick,
	disabled,
}: {
	icon: React.ReactNode;
	label: string;
	onClick(): void;
	disabled?: boolean;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			disabled={disabled}
			className="inline-flex items-center gap-1.5 rounded px-2 py-1.5 text-xs text-ink-700 transition hover:bg-ink-100 hover:text-accent disabled:opacity-40 dark:text-ink-200 dark:hover:bg-ink-700"
		>
			{icon}
			<span>{label}</span>
		</button>
	);
}

// 複習班講義 reader. Layout: ReaderToolbar (top) + EmbedPDFViewer (main) +
// LecturePanel (right on desktop / bottom-sheet on mobile).
//
// Personal highlights + a page-anchored notebook persist via the lecture API.
// Text selection raises a SelectionPopup anchored at the pointer-up point
// (page-coord rects are NOT usable for client placement — see the viewer
// contract). Snapshot rasterises the current page wrapper (canvas + annotation
// overlay) to the clipboard.
import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useSearchParams, Link } from "react-router-dom";
import { ChevronLeft } from "lucide-react";
import {
	EmbedPDFViewer,
	type EmbedPDFViewerHandle,
	type ViewerSelection,
	type AnnotationTransferItem,
} from "../components/lecture/EmbedPDFViewer";
import { ReaderToolbar } from "../components/lecture/ReaderToolbar";
import { SelectionPopup } from "../components/lecture/SelectionPopup";
import { LecturePanel } from "../components/lecture/LecturePanel";
import { LectureSearchBox } from "../components/lecture/LectureSearchBox";
import { useLectureNotes } from "../hooks/useLectureNotes";
import { useLectureAnnotations } from "../hooks/useLectureAnnotations";
import { getLecture, type LectureDoc } from "../lib/lectureApi";
import { blobToClipboard } from "../lib/snapshot";

type Toast = { kind: "ok" | "err"; msg: string } | null;

const PANEL_MIN = 280;
const PANEL_MAX = 640;
const PANEL_DEFAULT = 384;
const PANEL_WIDTH_KEY = "lecture-panel-width";

function clampPanelWidth(w: number) {
	return Math.min(PANEL_MAX, Math.max(PANEL_MIN, w));
}

export default function LectureReader() {
	const { slug = "" } = useParams<{ slug: string }>();
	const [doc, setDoc] = useState<LectureDoc | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);

	// Deep-link page from /lectures/:slug?page=N (used by lecture search). Snapped
	// at mount so navigating to a different page later doesn't re-jump. Kept in
	// a ref alongside an "applied" flag so we trigger scrollToPage exactly once,
	// on the first onPageChange (which is the viewer's signal that it's ready).
	const [searchParams] = useSearchParams();
	const initialPageRef = useRef<number | null>(
		(() => {
			const raw = searchParams.get("page");
			const n = raw ? parseInt(raw, 10) : NaN;
			return Number.isFinite(n) && n >= 1 ? n - 1 : null; // 0-indexed
		})(),
	);
	const initialJumpDoneRef = useRef(false);

	const viewerRef = useRef<EmbedPDFViewerHandle>(null);
	const pageNodeRef = useRef<HTMLElement | null>(null);
	// Pointer-RELEASE location (client px) — the anchor for the selection popup.
	const releaseRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
	// True while a pointer is held down (a drag-select in progress). We only show
	// the popup once the pointer is released, anchored at the release point.
	const draggingRef = useRef(false);
	// Reader-side mirror of the latest selection (selection-change is async).
	const selectionRef = useRef<ViewerSelection | null>(null);

	const [currentPage, setCurrentPage] = useState(0);
	const [highlightActive, setHighlightActive] = useState(false);
	const [panelOpen, setPanelOpen] = useState(true);
	const [thumbsOpen, setThumbsOpen] = useState(true);
	// Desktop panel width (px). Persisted as a UI layout pref (not app state).
	const [panelWidth, setPanelWidth] = useState<number>(() => {
		const raw =
			typeof localStorage !== "undefined"
				? localStorage.getItem(PANEL_WIDTH_KEY)
				: null;
		const n = raw ? Number(raw) : NaN;
		return Number.isFinite(n) ? clampPanelWidth(n) : PANEL_DEFAULT;
	});
	const [selection, setSelection] = useState<ViewerSelection | null>(null);
	const [popupAnchor, setPopupAnchor] = useState<{ x: number; y: number } | null>(
		null,
	);
	const [pendingNote, setPendingNote] = useState<{ text: string; page: number } | null>(
		null,
	);
	const [toast, setToast] = useState<Toast>(null);

	const notes = useLectureNotes(slug);
	const annos = useLectureAnnotations(slug);

	// Fetch lecture metadata (incl. pdf_url).
	useEffect(() => {
		let alive = true;
		setDoc(null);
		setLoadError(null);
		getLecture(slug)
			.then((d) => {
				if (alive) setDoc(d);
			})
			.catch((e) => {
				if (alive) setLoadError(e?.message || "載入講義失敗");
			});
		return () => {
			alive = false;
		};
	}, [slug]);

	// Auto-dismiss toasts.
	useEffect(() => {
		if (!toast) return;
		const t = setTimeout(() => setToast(null), 2400);
		return () => clearTimeout(t);
	}, [toast]);

	// Persist the panel width pref.
	useEffect(() => {
		try {
			localStorage.setItem(PANEL_WIDTH_KEY, String(panelWidth));
		} catch {
			/* ignore quota/availability errors */
		}
	}, [panelWidth]);

	// Drag-to-resize the desktop panel. Dragging the handle left widens it.
	const onResizeStart = useCallback(
		(e: React.PointerEvent<HTMLDivElement>) => {
			e.preventDefault();
			const startX = e.clientX;
			const startWidth = panelWidth;
			const handle = e.currentTarget;
			handle.setPointerCapture(e.pointerId);
			document.body.style.userSelect = "none";
			document.body.style.cursor = "col-resize";

			const onMove = (ev: PointerEvent) => {
				setPanelWidth(clampPanelWidth(startWidth + (startX - ev.clientX)));
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
		[panelWidth],
	);

	// Import persisted highlights once, after both the viewer is mounted and the
	// rows have finished loading.
	const importedRef = useRef(false);
	useEffect(() => {
		if (importedRef.current) return;
		if (annos.loading || !doc) return;
		const v = viewerRef.current;
		if (!v) return;
		if (annos.initialItems.length > 0) {
			v.importAnnotations(annos.initialItems);
		}
		importedRef.current = true;
	}, [annos.loading, annos.initialItems, doc]);

	// ── Stable viewer callbacks (the viewer re-subscribes on identity change) ──
	const onPageChange = useCallback((p: number) => setCurrentPage(p), []);

	// Apply the deep-link ?page= once the viewer signals the PDF layout is
	// ready — onPageChange doesn't fire on initial load (the page didn't change,
	// it started at 1), so the previous gating on it left the URL param
	// silently ignored.
	const onViewerReady = useCallback(() => {
		if (initialJumpDoneRef.current) return;
		initialJumpDoneRef.current = true;
		const target = initialPageRef.current;
		if (target !== null && target > 0) {
			viewerRef.current?.scrollToPage(target);
		}
	}, []);

	const onSelectionChange = useCallback((sel: ViewerSelection | null) => {
		selectionRef.current = sel;
		setSelection(sel);
		if (!sel || !sel.text.trim()) {
			// Selection cleared → hide popup.
			setPopupAnchor(null);
			return;
		}
		// Selection settled. Only show the popup if the pointer is already
		// released (e.g. the async text read resolved just after pointer-up);
		// while still dragging we wait for release so we can anchor at the
		// release point, not where the drag started.
		if (!draggingRef.current) {
			setPopupAnchor({ ...releaseRef.current });
		}
	}, []);

	const onPageContainer = useCallback((el: HTMLElement | null) => {
		pageNodeRef.current = el;
	}, []);

	// Pointer down = a (possible) drag-select begins: hide any open popup.
	const onPointerDown = useCallback(() => {
		draggingRef.current = true;
		setPopupAnchor(null);
	}, []);

	// Pointer up = release: record the release point and, if there's already a
	// non-empty selection, show the popup there.
	const onPointerUp = useCallback((e: React.PointerEvent | React.MouseEvent) => {
		draggingRef.current = false;
		releaseRef.current = { x: e.clientX, y: e.clientY };
		// Defer a frame so a click that CLEARS the selection (its synchronous
		// selection-change → null) runs first and we don't briefly flash the
		// popup with a stale selection.
		requestAnimationFrame(() => {
			const sel = selectionRef.current;
			if (sel && sel.text.trim()) setPopupAnchor({ ...releaseRef.current });
		});
	}, []);

	// ── Toolbar actions ──
	const prev = useCallback(() => {
		const v = viewerRef.current;
		if (v) v.scrollToPage(Math.max(0, v.getCurrentPage() - 1));
	}, []);
	const next = useCallback(() => {
		const v = viewerRef.current;
		if (v) v.scrollToPage(v.getCurrentPage() + 1);
	}, []);
	const goToPage = useCallback(
		(p: number) => {
			const max = Math.max(0, (doc?.page_count ?? 1) - 1);
			viewerRef.current?.scrollToPage(Math.min(Math.max(0, p), max));
		},
		[doc?.page_count],
	);
	const zoomIn = useCallback(() => viewerRef.current?.zoomIn(), []);
	const zoomOut = useCallback(() => viewerRef.current?.zoomOut(), []);
	const zoomFit = useCallback(() => viewerRef.current?.zoomFit(), []);

	const toggleHighlight = useCallback(() => {
		setHighlightActive((active) => {
			const nextActive = !active;
			viewerRef.current?.setActiveTool(nextActive ? "highlight" : null);
			return nextActive;
		});
	}, []);

	// Render the current page (with annotations baked in) to a PNG via pdfium and
	// put it on the clipboard (download fallback).
	const snapshot = useCallback(async () => {
		try {
			const blob = await viewerRef.current?.renderPageToBlob();
			if (!blob) {
				setToast({ kind: "err", msg: "截圖失敗" });
				return;
			}
			const where = await blobToClipboard(
				blob,
				`${slug}-p${currentPage + 1}.png`,
			);
			setToast({
				kind: "ok",
				msg: where === "clipboard" ? "已複製到剪貼簿" : "已下載截圖",
			});
		} catch {
			setToast({ kind: "err", msg: "截圖失敗" });
		}
	}, [slug, currentPage]);

	// ── Selection popup actions ──
	const dismissPopup = useCallback(() => {
		setPopupAnchor(null);
		setSelection(null);
	}, []);

	const doHighlight = useCallback(async () => {
		const v = viewerRef.current;
		if (!v) return;
		try {
			const anno = await v.createHighlightFromSelection();
			if (!anno) {
				setToast({ kind: "err", msg: "沒有可標記的選取" });
				return;
			}
			// Persist exactly what importAnnotations consumes: pull the transfer
			// item for the new annotation out of the fresh export.
			const items = await v.exportAnnotations();
			const item: AnnotationTransferItem | undefined =
				items.find((i) => i.annotation.id === anno.id) ?? { annotation: anno };
			await annos.persistHighlight(item);
			setToast({ kind: "ok", msg: "已標記" });
		} catch {
			setToast({ kind: "err", msg: "標記失敗" });
		} finally {
			dismissPopup();
		}
	}, [annos, dismissPopup]);

	const copyToNote = useCallback(
		(text: string, page: number) => {
			setPanelOpen(true);
			setPendingNote({ text, page });
			dismissPopup();
		},
		[dismissPopup],
	);

	const copyText = useCallback(
		async (text: string) => {
			try {
				await navigator.clipboard.writeText(text);
				setToast({ kind: "ok", msg: "已複製" });
			} catch {
				setToast({ kind: "err", msg: "複製失敗" });
			} finally {
				dismissPopup();
			}
		},
		[dismissPopup],
	);

	// ── Panel actions ──
	const jumpToAnnotation = useCallback((page: number) => {
		viewerRef.current?.scrollToPage(page);
	}, []);

	const deleteAnnotationRow = useCallback(
		(id: string, page: number) => {
			viewerRef.current?.deleteAnnotation(page, id);
			void annos.removeAnnotation(id, page);
		},
		[annos],
	);

	if (loadError) {
		return (
			<div className="p-8 text-center text-rose-600 dark:text-rose-400">
				無法載入講義：{loadError}
				<div className="mt-4">
					<Link to="/lectures" className="text-accent hover:underline">
						← 返回講義列表
					</Link>
				</div>
			</div>
		);
	}

	return (
		<div className="flex h-[calc(100vh-3.5rem)] flex-col md:h-[calc(100vh-4rem)]">
			{/* Title bar */}
			<div className="flex items-center gap-3 border-b border-ink-200 px-3 py-2 dark:border-ink-700">
				<Link
					to="/lectures"
					className="inline-flex shrink-0 items-center gap-1 text-sm text-ink-500 hover:text-accent dark:text-ink-400"
				>
					<ChevronLeft size={16} /> 講義
				</Link>
				<h1 className="truncate font-serif text-lg text-ink-900 dark:text-ink-100 shrink min-w-0">
					{doc?.title ?? "載入中…"}
				</h1>
				{slug && (
					<LectureSearchBox slug={slug} onJumpToPage={goToPage} />
				)}
			</div>

			<ReaderToolbar
				currentPage={currentPage}
				pageCount={doc?.page_count ?? 0}
				highlightActive={highlightActive}
				panelOpen={panelOpen}
				thumbnailsOpen={thumbsOpen}
				onToggleThumbnails={() => setThumbsOpen((o) => !o)}
				onPrev={prev}
				onNext={next}
				onGoToPage={goToPage}
				onZoomIn={zoomIn}
				onZoomOut={zoomOut}
				onZoomFit={zoomFit}
				onToggleHighlight={toggleHighlight}
				onSnapshot={snapshot}
				onTogglePanel={() => setPanelOpen((o) => !o)}
			/>

			{/* Body: viewer + panel */}
			<div className="flex min-h-0 flex-1">
				<div
					className="relative min-w-0 flex-1"
					onPointerDown={onPointerDown}
					onPointerUp={onPointerUp}
					onMouseUp={onPointerUp}
				>
					{doc?.pdf_url ? (
						<EmbedPDFViewer
							ref={viewerRef}
							pdfUrl={doc.pdf_url}
							onSelectionChange={onSelectionChange}
							onPageChange={onPageChange}
							onReady={onViewerReady}
							pageContainerRef={onPageContainer}
							showThumbnails={thumbsOpen}
						/>
					) : (
						<div className="flex h-full items-center justify-center font-serif text-2xl text-ink-300 dark:text-ink-600">
							載入講義中…
						</div>
					)}
				</div>

				{/* Drag handle (desktop only, when panel open). Sits between the
				    viewer and the panel; dragging left widens the panel. */}
				{panelOpen && (
					<div
						onPointerDown={onResizeStart}
						role="separator"
						aria-orientation="vertical"
						aria-label="調整面板寬度"
						className="hidden w-1.5 shrink-0 cursor-col-resize bg-ink-200 transition-colors hover:bg-accent dark:bg-ink-700 md:block"
					/>
				)}

				<LecturePanel
					open={panelOpen}
					onClose={() => setPanelOpen(false)}
					width={panelWidth}
					currentPage={currentPage}
					pageCount={doc?.page_count ?? 0}
					notesLoading={notes.loading}
					noteForPage={notes.noteForPage}
					onSavePageNote={notes.savePageNote}
					annotations={annos.annotations}
					onJumpToAnnotation={jumpToAnnotation}
					onDeleteAnnotation={deleteAnnotationRow}
					pendingNote={pendingNote}
					onConsumePending={() => setPendingNote(null)}
				/>
			</div>

			{/* Selection popup */}
			{popupAnchor && selection && (
				<SelectionPopup
					anchor={popupAnchor}
					selection={selection}
					currentPage={currentPage}
					onHighlight={doHighlight}
					onCopyToNote={copyToNote}
					onCopyText={copyText}
					onDismiss={dismissPopup}
				/>
			)}

			{/* Toast */}
			{toast && (
				<div
					className={
						"fixed bottom-6 left-1/2 z-50 -translate-x-1/2 animate-fade-in rounded-lg px-4 py-2 text-sm font-medium shadow-paper " +
						(toast.kind === "ok"
							? "bg-ink-800 text-ink-50 dark:bg-ink-100 dark:text-ink-900"
							: "bg-rose-600 text-white")
					}
					role="status"
				>
					{toast.msg}
				</div>
			)}
		</div>
	);
}

// EmbedPDF (pdfium-wasm) viewer wrapper for 複習班講義.
//
// This module is the ONLY place that imports `@embedpdf/*`. It is loaded
// exclusively from the lazy `/lectures/:slug` route (see App.tsx), so the
// pdfium-wasm + worker bundle never lands on any other route.
//
// The component renders a scrollable PDF from `pdfUrl` and exposes an
// imperative handle (see `EmbedPDFViewerHandle`) for the reader UI built in
// Task 9 — page nav, zoom, text selection → highlight, and annotation
// export/import round-trips for personal-annotation persistence.
import {
	forwardRef,
	useCallback,
	useEffect,
	useImperativeHandle,
	useMemo,
	useRef,
	useState,
} from "react";
import { usePdfiumEngine } from "@embedpdf/engines/react";
import { EmbedPDF } from "@embedpdf/core/react";
import { createPluginRegistration } from "@embedpdf/core";
import {
	DocumentManagerPluginPackage,
	useActiveDocument,
} from "@embedpdf/plugin-document-manager/react";
import { ViewportPluginPackage, Viewport } from "@embedpdf/plugin-viewport/react";
import { ScrollPluginPackage, Scroller, useScrollCapability } from "@embedpdf/plugin-scroll/react";
import {
	RenderPluginPackage,
	RenderLayer,
	useRenderCapability,
} from "@embedpdf/plugin-render/react";
import { TilingPluginPackage, TilingLayer } from "@embedpdf/plugin-tiling/react";
import {
	ThumbnailPluginPackage,
	ThumbnailsPane,
	ThumbImg,
} from "@embedpdf/plugin-thumbnail/react";
import { ZoomPluginPackage, useZoomCapability } from "@embedpdf/plugin-zoom/react";
import {
	InteractionManagerPluginPackage,
	PagePointerProvider,
} from "@embedpdf/plugin-interaction-manager/react";
import {
	SelectionPluginPackage,
	SelectionLayer,
	useSelectionCapability,
} from "@embedpdf/plugin-selection/react";
import {
	AnnotationPluginPackage,
	AnnotationLayer,
	useAnnotationCapability,
} from "@embedpdf/plugin-annotation/react";
import { ZoomMode } from "@embedpdf/plugin-zoom";
import { PDFPageSkeleton } from "../Skeleton";

// `@embedpdf/models` is a transitive dep that pnpm does not hoist to the app's
// node_modules, so it is not directly importable from app code (neither tsc
// nor esbuild can resolve `@embedpdf/models` from here). We therefore derive
// the few model types we need from the capability hook return types, and use
// the HIGHLIGHT subtype's numeric enum value directly.
type AnnotationCap = NonNullable<ReturnType<typeof useAnnotationCapability>["provides"]>;
/** Portable annotation item produced/consumed by export/importAnnotations. */
export type AnnotationTransferItem = Parameters<AnnotationCap["importAnnotations"]>[0][number];
/** A single PDF annotation object. */
export type PdfAnnotationObject = AnnotationTransferItem["annotation"];
/** Rect in PDF page coordinates (origin top-left, user units). */
interface Rect {
	origin: { x: number; y: number };
	size: { width: number; height: number };
}

// PdfAnnotationSubtype.HIGHLIGHT — see @embedpdf/models pdf.d.ts (enum value 9).
const HIGHLIGHT_SUBTYPE = 9 as PdfAnnotationObject["type"];

// ── Public surface ──────────────────────────────────────────────────────

export interface ViewerSelection {
	/** Plain text of the current selection. */
	text: string;
	/**
	 * Best-effort bounding rect of the selection's first page, in **page
	 * coordinates** (origin top-left, PDF user units). The reader maps this to
	 * client coords for popup anchoring — see the limitation note in the file
	 * footer.
	 */
	rect: { left: number; top: number; width: number; height: number };
	/** 0-based page index the selection starts on. */
	page: number;
}

export interface EmbedPDFViewerProps {
	pdfUrl: string;
	/** Fired whenever the text selection changes (null = cleared). */
	onSelectionChange?: (sel: ViewerSelection | null) => void;
	/** Fired when the visible page changes (0-based). */
	onPageChange?: (page: number) => void;
	/**
	 * Fired exactly once per document load, after the PDF layout is ready and
	 * `scrollToPage` is safe to call. Backed by the scroll plugin's
	 * `onLayoutReady` event with `isInitial: true`. Used by callers that want
	 * to apply a deep-link page (e.g. /lectures/:slug?page=N) — `onPageChange`
	 * doesn't fire on initial load (the page didn't change, it started there).
	 */
	onReady?: () => void;
	/**
	 * Receives the DOM node that wraps the rendered page canvas + annotation
	 * layer, so a later snapshot (Task 10) can rasterise both together. Called
	 * with `null` on unmount.
	 */
	pageContainerRef?: (el: HTMLElement | null) => void;
	/** Show the left thumbnail navigation rail. */
	showThumbnails?: boolean;
}

export interface EmbedPDFViewerHandle {
	/** Current 0-based page index. */
	getCurrentPage(): number;
	/** Scroll to a 0-based page index. */
	scrollToPage(page: number): void;
	zoomIn(): void;
	zoomOut(): void;
	/** Fit the page to the viewport width. */
	zoomFit(): void;
	/**
	 * Activate an annotation tool by id (e.g. `'highlight'`), or `null` to
	 * deactivate. See @embedpdf/plugin-annotation default tool ids.
	 */
	setActiveTool(tool: string | null): void;
	/**
	 * Create a highlight annotation from the current text selection. Resolves
	 * to the created annotation object (persist it via the API), or `null` if
	 * there is no active selection.
	 */
	createHighlightFromSelection(): Promise<PdfAnnotationObject | null>;
	/** Current text selection, or `null`. */
	getSelection(): ViewerSelection | null;
	/** Export all annotations as portable transfer items (for persistence). */
	exportAnnotations(): Promise<AnnotationTransferItem[]>;
	/** Import previously-exported annotation transfer items. */
	importAnnotations(items: AnnotationTransferItem[]): void;
	/** Delete an annotation by id on a given 0-based page. */
	deleteAnnotation(page: number, id: string): void;
	/**
	 * Render a page (default = current) to a PNG Blob WITH annotations baked in,
	 * via pdfium. Used for the snapshot feature — far more robust than
	 * DOM-rasterising the wasm-rendered page. Resolves `null` on failure.
	 */
	renderPageToBlob(page?: number): Promise<Blob | null>;
}

// ── Plugin set (shared by every lecture document) ─────────────────────────

function buildPlugins(pdfUrl: string) {
	return [
		createPluginRegistration(DocumentManagerPluginPackage, {
			initialDocuments: [{ url: pdfUrl }],
		}),
		createPluginRegistration(ViewportPluginPackage),
		createPluginRegistration(ScrollPluginPackage),
		createPluginRegistration(RenderPluginPackage),
		createPluginRegistration(TilingPluginPackage),
		createPluginRegistration(ThumbnailPluginPackage, { width: 120 }),
		createPluginRegistration(ZoomPluginPackage, {
			defaultZoomLevel: ZoomMode.FitWidth,
		}),
		// Required peer for pointer-driven selection/annotation interactions.
		createPluginRegistration(InteractionManagerPluginPackage),
		createPluginRegistration(SelectionPluginPackage),
		createPluginRegistration(AnnotationPluginPackage, {
			// Personal annotations persist via our API, but auto-commit into the
			// in-memory pdfium doc keeps export/import + on-canvas rendering simple.
			autoCommit: true,
		}),
	];
}

// ── Component ─────────────────────────────────────────────────────────────

export const EmbedPDFViewer = forwardRef<EmbedPDFViewerHandle, EmbedPDFViewerProps>(
	function EmbedPDFViewer(props, ref) {
		const { engine, isLoading, error } = usePdfiumEngine();
		const plugins = useMemo(() => buildPlugins(props.pdfUrl), [props.pdfUrl]);

		if (error) {
			return (
				<div className="flex h-full w-full items-center justify-center p-8 text-center">
					<div>
						<p className="font-serif text-lg text-ink-700 dark:text-ink-200">
							無法載入 PDF 引擎
						</p>
						<p className="mt-1 text-sm text-ink-400 dark:text-ink-500">
							{error.message}
						</p>
					</div>
				</div>
			);
		}

		if (isLoading || !engine) {
			return <ViewerSkeleton />;
		}

		return (
			<EmbedPDF engine={engine} plugins={plugins}>
				<ViewerInner forwardedRef={ref} {...props} />
			</EmbedPDF>
		);
	},
);

function ViewerSkeleton() {
	// Slide-shaped placeholder while the WASM pdfium engine boots and the
	// initial document binary is fetched. Reuses the shared skeleton so the
	// pre-engine state and the LectureReader's pre-doc state look identical.
	return <PDFPageSkeleton label="初始化 PDF 引擎…" />;
}

// Rendered INSIDE <EmbedPDF>, so the plugin context / capability hooks resolve.
function ViewerInner({
	forwardedRef,
	onSelectionChange,
	onPageChange,
	onReady,
	pageContainerRef,
	showThumbnails,
}: EmbedPDFViewerProps & {
	forwardedRef: React.ForwardedRef<EmbedPDFViewerHandle>;
}) {
	const { activeDocumentId } = useActiveDocument();
	const { provides: selection } = useSelectionCapability();
	const { provides: annotation } = useAnnotationCapability();
	const { provides: scroll } = useScrollCapability();
	const { provides: zoom } = useZoomCapability();
	const { provides: render } = useRenderCapability();
	// Local copy of the current page (0-based) for highlighting the active
	// thumbnail; kept in sync via the same scroll page-change subscription.
	const [activePage, setActivePage] = useState(0);

	// Latest known selection, kept in a ref so the imperative handle and the
	// highlight action can read it synchronously.
	const selectionRef = useRef<ViewerSelection | null>(null);

	const docId = activeDocumentId ?? "";

	// Convert a page-space Rect into the popup-anchor shape.
	const toRect = useCallback(
		(r: Rect) => ({
			left: r.origin.x,
			top: r.origin.y,
			width: r.size.width,
			height: r.size.height,
		}),
		[],
	);

	// Read the current selection from the capability (text is async via Task).
	const readSelection = useCallback((): Promise<ViewerSelection | null> => {
		if (!selection || !docId) return Promise.resolve(null);
		const formatted = selection.getFormattedSelection(docId);
		if (!formatted || formatted.length === 0) return Promise.resolve(null);
		const first = formatted[0];
		return new Promise<ViewerSelection | null>((resolve) => {
			const task = selection.getSelectedText(docId);
			task.wait(
				(parts) => {
					resolve({
						text: parts.join("\n").trim(),
						rect: toRect(first.rect),
						page: first.pageIndex,
					});
				},
				() => resolve(null),
			);
		});
	}, [selection, docId, toRect]);

	// Subscribe to selection changes → surface text + rect + page upward.
	useEffect(() => {
		if (!selection || !docId || !onSelectionChange) return;
		const unsub = selection.onSelectionChange((evt) => {
			if (evt.documentId !== docId) return;
			if (!evt.selection) {
				selectionRef.current = null;
				onSelectionChange(null);
				return;
			}
			readSelection().then((sel) => {
				selectionRef.current = sel;
				onSelectionChange(sel);
			});
		});
		return unsub;
	}, [selection, docId, onSelectionChange, readSelection]);

	// Subscribe to page changes (drives both the outward callback and the local
	// active-page state used to highlight the current thumbnail).
	useEffect(() => {
		if (!scroll || !docId) return;
		const unsub = scroll.onPageChange((evt) => {
			if (evt.documentId !== docId) return;
			// PageChangeEvent.pageNumber is 1-based; expose 0-based.
			const p = Math.max(0, evt.pageNumber - 1);
			setActivePage(p);
			onPageChange?.(p);
		});
		return unsub;
	}, [scroll, docId, onPageChange]);

	// Fire the outward onReady callback exactly once per document load. The SDK
	// emits `onLayoutReady` with `isInitial: true` after the first layout pass —
	// the first moment scrollToPage() is safe to call. We can't piggy-back on
	// onPageChange for this because the doc opens at page 1 and stays there, so
	// no page-change event fires.
	useEffect(() => {
		if (!scroll || !docId || !onReady) return;
		const unsub = scroll.onLayoutReady((evt) => {
			if (evt.documentId !== docId) return;
			if (!evt.isInitial) return;
			onReady();
		});
		return unsub;
	}, [scroll, docId, onReady]);

	// Build a highlight annotation object from the current selection geometry.
	const createHighlightFromSelection = useCallback(async (): Promise<PdfAnnotationObject | null> => {
		if (!annotation || !selection || !docId) return null;
		const formatted = selection.getFormattedSelectionForPage(
			selectionRef.current?.page ?? 0,
			docId,
		);
		// Fall back to the first available formatted selection if the cached page
		// is stale.
		const all = selection.getFormattedSelection(docId);
		const target = formatted ?? (all.length > 0 ? all[0] : null);
		if (!target) return null;

		const scope = annotation.forDocument(docId);
		const id =
			typeof crypto !== "undefined" && "randomUUID" in crypto
				? crypto.randomUUID()
				: `hl-${Date.now()}-${Math.random().toString(36).slice(2)}`;
		const anno = {
			type: HIGHLIGHT_SUBTYPE,
			id,
			pageIndex: target.pageIndex,
			rect: target.rect,
			segmentRects: target.segmentRects,
			opacity: 1,
			strokeColor: "#FBBF24", // amber-400 — matches the editorial accent.
			color: "#FBBF24",
		} as PdfAnnotationObject;

		scope.createAnnotation(target.pageIndex, anno);
		// Clear the live selection now that it has become a highlight.
		selection.clear(docId);
		selectionRef.current = null;
		return anno;
	}, [annotation, selection, docId]);

	useImperativeHandle(
		forwardedRef,
		(): EmbedPDFViewerHandle => ({
			getCurrentPage() {
				if (!scroll || !docId) return 0;
				// ScrollCapability.getCurrentPage() is 1-based; expose 0-based.
				return Math.max(0, scroll.forDocument(docId).getCurrentPage() - 1);
			},
			scrollToPage(page: number) {
				if (!scroll || !docId) return;
				scroll.forDocument(docId).scrollToPage({ pageNumber: page + 1 });
			},
			zoomIn() {
				if (!zoom || !docId) return;
				zoom.forDocument(docId).zoomIn();
			},
			zoomOut() {
				if (!zoom || !docId) return;
				zoom.forDocument(docId).zoomOut();
			},
			zoomFit() {
				if (!zoom || !docId) return;
				zoom.forDocument(docId).requestZoom(ZoomMode.FitWidth);
			},
			setActiveTool(tool: string | null) {
				if (!annotation || !docId) return;
				annotation.forDocument(docId).setActiveTool(tool);
			},
			createHighlightFromSelection,
			getSelection() {
				return selectionRef.current;
			},
			exportAnnotations() {
				if (!annotation || !docId) return Promise.resolve([]);
				return new Promise<AnnotationTransferItem[]>((resolve) => {
					annotation
						.exportAnnotations(undefined, docId)
						.wait((items) => resolve(items), () => resolve([]));
				});
			},
			importAnnotations(items: AnnotationTransferItem[]) {
				if (!annotation || !docId) return;
				annotation.forDocument(docId).importAnnotations(items);
			},
			deleteAnnotation(page: number, id: string) {
				if (!annotation || !docId) return;
				annotation.forDocument(docId).deleteAnnotation(page, id);
			},
			renderPageToBlob(page?: number) {
				if (!render || !docId) return Promise.resolve(null);
				const pageIndex =
					page ??
					(scroll
						? Math.max(0, scroll.forDocument(docId).getCurrentPage() - 1)
						: 0);
				return new Promise<Blob | null>((resolve) => {
					render.forDocument(docId).renderPage({
						pageIndex,
						options: { scaleFactor: 2, withAnnotations: true },
					}).wait(
						(blob) => resolve(blob),
						() => resolve(null),
					);
				});
			},
		}),
		[scroll, zoom, annotation, render, docId, createHighlightFromSelection],
	);

	if (!activeDocumentId) {
		return <ViewerSkeleton />;
	}

	return (
		<div className="flex h-full w-full">
			{showThumbnails && (
				<ThumbnailRail
					documentId={activeDocumentId}
					activePage={activePage}
					onJump={(p) =>
						scroll?.forDocument(activeDocumentId).scrollToPage({ pageNumber: p + 1 })
					}
				/>
			)}
			<Viewport
				documentId={activeDocumentId}
				className="h-full min-w-0 flex-1 overflow-auto bg-ink-100 dark:bg-ink-900"
			>
			<Scroller
				documentId={activeDocumentId}
				renderPage={({ pageIndex, width, height }) => (
					<div
						key={pageIndex}
						// The pdfium-rendered page is an <img>, which is natively
						// draggable — a mouse-drag would start HTML5 image drag-and-drop
						// (a ghost of the whole slide) and preempt EmbedPDF text
						// selection. Cancel dragstart so drag = select text, not drag image.
						onDragStart={(e) => e.preventDefault()}
						ref={(el) => {
							// Surface the visible page's wrapper (canvas + annotation
							// overlay) so the snapshot tool can rasterise both. We only
							// track the current page to avoid churn.
							if (
								pageContainerRef &&
								scroll &&
								pageIndex === scroll.forDocument(activeDocumentId).getCurrentPage() - 1
							) {
								pageContainerRef(el);
							}
						}}
						style={{ width, height, position: "relative" }}
					>
						{/* PagePointerProvider is REQUIRED for text selection +
						    annotation pointer interactions to work — it wires the
						    InteractionManager's pointer handlers to this page and maps
						    client points into PDF page coords. Without it the
						    SelectionLayer/AnnotationLayer render but never receive input.
						    Layers omit scale/rotation → they read the document's current
						    state (zoom level, page rotation) automatically. */}
						<PagePointerProvider
							documentId={activeDocumentId}
							pageIndex={pageIndex}
							style={{
								position: "absolute",
								inset: 0,
								width,
								height,
							}}
						>
							<RenderLayer documentId={activeDocumentId} pageIndex={pageIndex} />
							<TilingLayer documentId={activeDocumentId} pageIndex={pageIndex} />
							<SelectionLayer
							documentId={activeDocumentId}
							pageIndex={pageIndex}
							// Default is an opaque rgba(33,150,243); soften it so selected
							// text stays readable underneath.
							textStyle={{ background: "rgba(33,150,243,0.28)" }}
						/>
							<AnnotationLayer documentId={activeDocumentId} pageIndex={pageIndex} />
						</PagePointerProvider>
					</div>
				)}
			/>
			</Viewport>
		</div>
	);
}

// Left thumbnail navigation rail (desktop). Virtualised via ThumbnailsPane:
// the render-prop yields one ThumbMeta per visible page, positioned absolutely
// at `meta.top` within the pane's scroll content.
function ThumbnailRail({
	documentId,
	activePage,
	onJump,
}: {
	documentId: string;
	activePage: number;
	onJump(page: number): void;
}) {
	return (
		<aside className="hidden h-full w-40 shrink-0 overflow-hidden border-r border-ink-200 bg-white md:block dark:border-ink-700 dark:bg-ink-900">
			<ThumbnailsPane
				documentId={documentId}
				style={{ height: "100%", overflowY: "auto", position: "relative" }}
			>
				{(m: any) => (
					<div
						key={m.pageIndex}
						style={{
							position: "absolute",
							top: m.top,
							height: m.wrapperHeight,
							left: 0,
							right: 0,
						}}
						className="flex flex-col items-center"
					>
						<button
							type="button"
							onClick={() => onJump(m.pageIndex)}
							aria-label={`第 ${m.pageIndex + 1} 頁`}
							title={`第 ${m.pageIndex + 1} 頁`}
							className={
								"overflow-hidden rounded border-2 bg-white shadow-sm transition " +
								(m.pageIndex === activePage
									? "border-accent"
									: "border-ink-200/60 hover:border-ink-400 dark:border-ink-700 dark:hover:border-ink-500")
							}
						>
							<ThumbImg
								documentId={documentId}
								meta={m}
								style={{ display: "block" }}
							/>
						</button>
						<span
							className={
								"mt-0.5 text-[11px] " +
								(m.pageIndex === activePage
									? "font-medium text-accent"
									: "text-ink-400 dark:text-ink-500")
							}
						>
							{m.pageIndex + 1}
						</span>
					</div>
				)}
			</ThumbnailsPane>
		</aside>
	);
}

// ── Limitations / notes for the reader agent (Task 9) ─────────────────────
//
// - SELECTION GEOMETRY: `onSelectionChange` reports `rect` in PAGE coordinates
//   (PDF user units, origin top-left), NOT client/viewport pixels. To anchor a
//   popup you must convert: multiply by the current scale and add the page
//   element's bounding-rect offset. `ScrollCapability.getRectPositionForPage()`
//   can also map a page rect to scroller-content coordinates. This was left to
//   the reader because popup placement depends on the reader's layout (panel
//   width, sticky toolbar height) which is unknown here.
// - PAGE CONTAINER: `pageContainerRef` is wired to the CURRENT page's wrapper
//   div (which contains both RenderLayer canvas and AnnotationLayer overlay),
//   so html-to-image will capture highlights/notes. If the user scrolls
//   mid-capture the ref may point at a different page than expected; the reader
//   should snapshot right after `scrollToPage` settles.
// - createHighlightFromSelection uses `getFormattedSelectionForPage` /
//   `getFormattedSelection` which return `{ pageIndex, rect, segmentRects }` —
//   exactly the fields a HIGHLIGHT annotation needs, so geometry is exact.

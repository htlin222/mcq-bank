// Personal highlight persistence for a single lecture.
//
// PERSISTENCE MODEL (see design doc §4 + the EmbedPDFViewer contract):
// `payload_json` stores exactly one `AnnotationTransferItem` — the same shape
// `viewer.importAnnotations()` consumes and `viewer.exportAnnotations()`
// produces. On reload we feed `initialItems` (the rows' payloads) straight into
// `importAnnotations`, so there is no lossy reconstruction.
//
// When the user highlights, the reader calls `viewer.createHighlightFromSelection()`
// (which draws it immediately) and then `viewer.exportAnnotations()`, picks the
// transfer item whose `annotation.id` matches the new annotation, and passes it
// to `persistHighlight`. This guarantees the stored shape round-trips exactly.
import { useCallback, useEffect, useMemo, useState } from "react";
import {
	listAnnotations,
	createAnnotation as apiCreateAnnotation,
	deleteAnnotation as apiDeleteAnnotation,
	type LectureAnnotation,
} from "../lib/lectureApi";
import type { AnnotationTransferItem } from "../components/lecture/EmbedPDFViewer";

export interface UseLectureAnnotations {
	annotations: LectureAnnotation[];
	loading: boolean;
	error: string | null;
	/** Transfer items to feed `viewer.importAnnotations(...)` once the viewer is ready. */
	initialItems: AnnotationTransferItem[];
	/** Persist a freshly-created highlight transfer item (POST). */
	persistHighlight(item: AnnotationTransferItem): Promise<void>;
	/** Delete a highlight row (the caller also removes it from the viewer canvas). */
	removeAnnotation(id: string, page: number): Promise<void>;
}

function byPageThenTime(a: LectureAnnotation, b: LectureAnnotation) {
	if (a.page !== b.page) return a.page - b.page;
	return a.created_at - b.created_at;
}

export function useLectureAnnotations(slug: string): UseLectureAnnotations {
	const [annotations, setAnnotations] = useState<LectureAnnotation[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let alive = true;
		setLoading(true);
		listAnnotations(slug)
			.then((rows) => {
				if (alive) {
					setAnnotations([...rows].sort(byPageThenTime));
					setError(null);
				}
			})
			.catch((e) => {
				if (alive) setError(e?.message || "載入標註失敗");
			})
			.finally(() => {
				if (alive) setLoading(false);
			});
		return () => {
			alive = false;
		};
	}, [slug]);

	// Highlight rows → transfer items for the viewer. We tolerate a stringified
	// payload defensively, though the API already hands back parsed JSON.
	const initialItems = useMemo<AnnotationTransferItem[]>(() => {
		const items: AnnotationTransferItem[] = [];
		for (const row of annotations) {
			if (row.kind !== "highlight") continue;
			let payload = row.payload_json;
			if (typeof payload === "string") {
				try {
					payload = JSON.parse(payload);
				} catch {
					continue;
				}
			}
			if (payload && payload.annotation) items.push(payload as AnnotationTransferItem);
		}
		return items;
	}, [annotations]);

	const persistHighlight = useCallback(
		async (item: AnnotationTransferItem) => {
			const page = item.annotation.pageIndex;
			const id = item.annotation.id;
			// Optimistic row so the 標註 list updates immediately.
			const now = Date.now();
			const optimistic: LectureAnnotation = {
				id,
				slug,
				page,
				kind: "highlight",
				payload_json: item,
				created_at: now,
				updated_at: now,
			};
			setAnnotations((prev) => [...prev, optimistic].sort(byPageThenTime));
			try {
				const saved = await apiCreateAnnotation(slug, {
					kind: "highlight",
					page,
					payload_json: item,
				});
				// Reconcile id/timestamps with the server row (key on the annotation id).
				setAnnotations((prev) =>
					prev.map((a) => (a.id === id ? saved : a)).sort(byPageThenTime),
				);
			} catch (e) {
				setAnnotations((prev) => prev.filter((a) => a.id !== id));
				setError(e instanceof Error ? e.message : String(e));
				throw e;
			}
		},
		[slug],
	);

	const removeAnnotation = useCallback(
		async (id: string, _page: number) => {
			const before = annotations;
			setAnnotations((prev) => prev.filter((a) => a.id !== id));
			try {
				await apiDeleteAnnotation(slug, id);
			} catch (e) {
				setAnnotations(before);
				setError(e instanceof Error ? e.message : String(e));
				throw e;
			}
		},
		[slug, annotations],
	);

	return {
		annotations,
		loading,
		error,
		initialItems,
		persistHighlight,
		removeAnnotation,
	};
}

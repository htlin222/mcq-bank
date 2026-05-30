// Page-anchored notebook for a single lecture. Loads once on mount, then
// exposes optimistic create/update/remove with rollback on API error.
//
// Notes are per-user server-side (the API scopes rows to the caller's email),
// so every returned row is editable/deletable by the current user.
import { useCallback, useEffect, useState } from "react";
import {
	listNotes,
	createNote as apiCreateNote,
	updateNote as apiUpdateNote,
	deleteNote as apiDeleteNote,
	putPageNote as apiPutPageNote,
	type LectureNote,
} from "../lib/lectureApi";

export interface UseLectureNotes {
	notes: LectureNote[];
	loading: boolean;
	error: string | null;
	createNote(input: {
		page: number | null;
		content_json: any;
	}): Promise<LectureNote | null>;
	updateNote(
		id: string,
		patch: { content_json?: any; page?: number | null },
	): Promise<void>;
	removeNote(id: string): Promise<void>;
	/** The single note for a page (newest wins if old data has duplicates). */
	noteForPage(page: number): LectureNote | undefined;
	/** Optimistically upsert the one note for `page`. */
	savePageNote(page: number, content_json: any): Promise<void>;
}

function byNewest(a: LectureNote, b: LectureNote) {
	return b.created_at - a.created_at;
}

export function useLectureNotes(slug: string): UseLectureNotes {
	const [notes, setNotes] = useState<LectureNote[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let alive = true;
		setLoading(true);
		listNotes(slug)
			.then((rows) => {
				if (alive) {
					setNotes([...rows].sort(byNewest));
					setError(null);
				}
			})
			.catch((e) => {
				if (alive) setError(e?.message || "載入筆記失敗");
			})
			.finally(() => {
				if (alive) setLoading(false);
			});
		return () => {
			alive = false;
		};
	}, [slug]);

	const createNote = useCallback(
		async (input: { page: number | null; content_json: any }) => {
			// Optimistic insert with a temporary row; swap for the server row on success.
			const now = Date.now();
			const tempId = `tmp-${now}-${Math.random().toString(36).slice(2)}`;
			const optimistic: LectureNote = {
				id: tempId,
				slug,
				page: input.page,
				content_json: input.content_json,
				created_at: now,
				updated_at: now,
			};
			setNotes((prev) => [optimistic, ...prev].sort(byNewest));
			try {
				const saved = await apiCreateNote(slug, input);
				setNotes((prev) =>
					prev.map((n) => (n.id === tempId ? saved : n)).sort(byNewest),
				);
				return saved;
			} catch (e) {
				// Rollback the optimistic row.
				setNotes((prev) => prev.filter((n) => n.id !== tempId));
				setError(e instanceof Error ? e.message : String(e));
				return null;
			}
		},
		[slug],
	);

	const updateNote = useCallback(
		async (
			id: string,
			patch: { content_json?: any; page?: number | null },
		) => {
			const before = notes.find((n) => n.id === id);
			setNotes((prev) =>
				prev.map((n) =>
					n.id === id ? { ...n, ...patch, updated_at: Date.now() } : n,
				),
			);
			try {
				await apiUpdateNote(slug, id, patch);
			} catch (e) {
				if (before) setNotes((prev) => prev.map((n) => (n.id === id ? before : n)));
				setError(e instanceof Error ? e.message : String(e));
			}
		},
		[slug, notes],
	);

	const removeNote = useCallback(
		async (id: string) => {
			const before = notes;
			setNotes((prev) => prev.filter((n) => n.id !== id));
			try {
				await apiDeleteNote(slug, id);
			} catch (e) {
				setNotes(before);
				setError(e instanceof Error ? e.message : String(e));
			}
		},
		[slug, notes],
	);

	const noteForPage = useCallback(
		(page: number) => {
			// Newest wins if legacy data left more than one row for a page.
			let found: LectureNote | undefined;
			for (const n of notes) {
				if (n.page !== page) continue;
				if (!found || n.created_at > found.created_at) found = n;
			}
			return found;
		},
		[notes],
	);

	const savePageNote = useCallback(
		async (page: number, content_json: any) => {
			const before = notes;
			const existing = before.find((n) => n.page === page);
			const now = Date.now();
			// Optimistic: dedupe to at most one row per page, update or insert.
			setNotes((prev) => {
				const others = prev.filter((n) => n.page !== page);
				if (existing) {
					return [
						{ ...existing, content_json, updated_at: now },
						...others,
					].sort(byNewest);
				}
				const tempId = `tmp-${now}-${Math.random().toString(36).slice(2)}`;
				const optimistic: LectureNote = {
					id: tempId,
					slug,
					page,
					content_json,
					created_at: now,
					updated_at: now,
				};
				return [optimistic, ...others].sort(byNewest);
			});
			try {
				const saved = await apiPutPageNote(slug, page, content_json);
				// Replace whatever we have for this page with the server row.
				setNotes((prev) =>
					[saved, ...prev.filter((n) => n.page !== page)].sort(byNewest),
				);
			} catch (e) {
				setNotes(before);
				setError(e instanceof Error ? e.message : String(e));
			}
		},
		[slug, notes],
	);

	return {
		notes,
		loading,
		error,
		createNote,
		updateNote,
		removeNote,
		noteForPage,
		savePageNote,
	};
}

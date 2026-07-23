// Typed wrappers over the lecture (複習班講義) + AI endpoints. Reuses the shared
// `api` fetch helper — do not introduce a second fetch layer here.
import { api } from "./api";

export interface LectureDoc {
	slug: string;
	title: string;
	instructor: string;
	sort_order: number;
	r2_key: string;
	page_count: number;
	bytes: number;
	created_at: number;
	anno_count: number;
	note_count: number;
	// 'lecture' (複習班講義) | 'textbook' (Wintrobe 唯讀參考書章節, migration 0033).
	// Textbook chapters open in this same reader via /lectures/:slug?page=N but
	// suppress all write affordances (highlight / notebook).
	kind?: "lecture" | "textbook";
	// present only on single-doc GET
	pdf_url?: string;
}

export interface LectureAnnotation {
	id: string;
	slug: string;
	page: number;
	kind: "highlight" | "note";
	payload_json: any;
	created_at: number;
	updated_at: number;
}

export interface LectureNote {
	id: string;
	slug: string;
	page: number | null;
	content_json: any;
	created_at: number;
	updated_at: number;
}

// ── Registry ──────────────────────────────────────────────────────────

export function listLectures(): Promise<LectureDoc[]> {
	return api.get<LectureDoc[]>("/api/lectures");
}

export function getLecture(slug: string): Promise<LectureDoc> {
	return api.get<LectureDoc>(`/api/lectures/${slug}`);
}

// ── Textbook (Wintrobe) chapters ──────────────────────────────────────
//
// Flat, sort_order-ordered chapter list for the「Wintrobe's」分頁. Grouped
// into Parts client-side. Each chapter opens read-only in the same reader
// via /lectures/:slug (kind='textbook' suppresses write affordances).

export interface TextbookChapter {
	slug: string;
	title: string; // "Wintrobe Ch1 · Examination of the Blood and Bone Marrow"
	sort_order: number; // = chapter number
	page_count: number;
}

export function listTextbookChapters(): Promise<TextbookChapter[]> {
	return api.get<TextbookChapter[]>("/api/textbook/chapters");
}

// ── Search ───────────────────────────────────────────────────────────
//
// Snippet is the FTS5 snippet() output with `` / `` as the
// match-highlight markers. Render via <HighlightedSnippet> on the client
// — the markers map to <mark> / </mark> as React elements, so the snippet
// never reaches dangerouslySetInnerHTML.

export type LectureSearchScope = "pdf" | "notes";

export interface LectureSearchHit {
	slug: string;
	page: number;
	title: string;
	instructor: string;
	snippet: string;
}

export interface LectureSearchResponse {
	results: LectureSearchHit[];
	scope: LectureSearchScope;
	q: string;
}

/**
 * @param slug  Optional — when set, results are restricted to a single lecture.
 *              Used by the in-reader search box on /lectures/:slug.
 */
export function searchLectures(
	q: string,
	scope: LectureSearchScope = "pdf",
	limit = 20,
	slug?: string,
): Promise<LectureSearchResponse> {
	const u = new URLSearchParams({ q, scope, limit: String(limit) });
	if (slug) u.set("slug", slug);
	return api.get<LectureSearchResponse>(`/api/lectures/search?${u.toString()}`);
}

// ── Annotations ──────────────────────────────────────────────────────

export function listAnnotations(slug: string): Promise<LectureAnnotation[]> {
	return api.get<LectureAnnotation[]>(`/api/lectures/${slug}/annotations`);
}

export function createAnnotation(
	slug: string,
	body: { kind: "highlight" | "note"; page: number; payload_json: any },
): Promise<LectureAnnotation> {
	return api.post<LectureAnnotation>(`/api/lectures/${slug}/annotations`, body);
}

export function updateAnnotation(
	slug: string,
	id: string,
	patch: { payload_json?: any; page?: number },
): Promise<{ ok: true; updated_at: number }> {
	return api.patch<{ ok: true; updated_at: number }>(
		`/api/lectures/${slug}/annotations/${id}`,
		patch,
	);
}

export function deleteAnnotation(
	slug: string,
	id: string,
): Promise<{ ok: true }> {
	return api.del<{ ok: true }>(`/api/lectures/${slug}/annotations/${id}`);
}

// ── Notebook ─────────────────────────────────────────────────────────

export function listNotes(slug: string): Promise<LectureNote[]> {
	return api.get<LectureNote[]>(`/api/lectures/${slug}/notes`);
}

export function createNote(
	slug: string,
	body: { page: number | null; content_json: any },
): Promise<LectureNote> {
	return api.post<LectureNote>(`/api/lectures/${slug}/notes`, body);
}

export function updateNote(
	slug: string,
	id: string,
	patch: { content_json?: any; page?: number | null },
): Promise<{ ok: true; updated_at: number }> {
	return api.patch<{ ok: true; updated_at: number }>(
		`/api/lectures/${slug}/notes/${id}`,
		patch,
	);
}

export function deleteNote(slug: string, id: string): Promise<{ ok: true }> {
	return api.del<{ ok: true }>(`/api/lectures/${slug}/notes/${id}`);
}

// Upsert the single note for a given page (1 note per user/slug/page).
export function putPageNote(
	slug: string,
	page: number,
	content_json: any,
): Promise<LectureNote> {
	return api.put<LectureNote>(`/api/lectures/${slug}/notes/by-page/${page}`, {
		content_json,
	});
}

// ── AI ───────────────────────────────────────────────────────────────

// Explain a free-text slide selection via Workers AI.
export function explainSelection(text: string): Promise<{ text: string }> {
	return api.post<{ text: string }>("/api/ai/explain-selection", { text });
}

// Typed wrappers over the lecture (複習班講義) + AI endpoints. Reuses the shared
// `api` fetch helper — do not introduce a second fetch layer here.
import { api } from "./api";
import { createQuestionStore } from "./questionStore";

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

// kind='lecture' (複習班講義, default) or 'textbook' (Wintrobe 章節). The grid
// on /lectures switches between the two via a tab.
export function listLectures(
	kind: "lecture" | "textbook" = "lecture",
): Promise<LectureDoc[]> {
	const q = kind === "textbook" ? "?kind=textbook" : "";
	return api.get<LectureDoc[]>(`/api/lectures${q}`);
}

/**
 * 講義/教科書清單的快取,以 kind 為鍵。
 *
 * /lectures 的三個分頁原本每切一次就 setDocs(null) 再重抓,所以來回比對講義與
 * 教科書時,每一下都是一輪骨架 —— 而這份清單只有匯入時才會變。`peek()` 同步
 * 可讀,所以回到看過的分頁是即時的,不閃骨架。
 *
 * ttl 五分鐘:匯入是離線腳本,五分鐘內看到舊清單沒有任何後果。
 */
export const lectureListCache = createQuestionStore<LectureDoc[]>(
	(kind) => listLectures(kind as "lecture" | "textbook"),
	{ max: 4, ttlMs: 5 * 60_000 },
);

export function getLecture(slug: string): Promise<LectureDoc> {
	return api.get<LectureDoc>(`/api/lectures/${slug}`);
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

// ── 歷屆考題 (past-exam MCQ links) ──────────────────────────────────────
//
// One page's worth of MCQs, pre-computed offline by
// scripts/build-slide-mcq-links.ts and joined in worker/routes/lectures.ts.
// Always returns [] rather than throwing (missing table / unbackfilled page).

export interface LecturePageQuestion {
	id: string;
	year: number;
	group: "內科" | "共同" | null;
	stem: string;
	options_json: string;
	answer: string;
	score: number;
	rank: number;
	tags: string | null; // space-joined GROUP_CONCAT
}

/** @param page 1-based PDF page (currentPage + 1). */
export function listPageQuestions(slug: string, page: number): Promise<LecturePageQuestion[]> {
	return api.get<LecturePageQuestion[]>(`/api/lectures/${slug}/questions?page=${page}`);
}

// ── AI ───────────────────────────────────────────────────────────────

// Explain a free-text slide selection via Workers AI.
export function explainSelection(text: string): Promise<{ text: string }> {
	return api.post<{ text: string }>("/api/ai/explain-selection", { text });
}

// ── 書籤 (migration 0042) ─────────────────────────────────────────────
//
// 一則書籤 = 「某人在某份講義的某一頁插了旗子」。頁碼一律 1-based —— 跟
// lecture_notes 一致(預覽就是 join 它來的),跟 lecture_annotations 不一致
// (那張表是 0-based)。0/1 的轉換只發生在 LectureReader 那一處。

export interface LectureBookmark {
	id: string;
	slug: string;
	/** 1-based PDF 頁碼。 */
	page: number;
	created_at: number;
	/** 講義標題(伺服器 join lecture_docs 帶回來的)。 */
	title: string;
	instructor: string;
	sort_order: number;
	/** 同一頁 lecture_notes 的純文字開頭;那一頁沒筆記時是空字串。 */
	note_preview: string;
}

/**
 * 全部書籤(/lectures?tab=bookmark)。
 *
 * 快取沿用 createQuestionStore,理由同 freeNoteListCache:切分頁時 `peek()`
 * 同步可讀,回到看過的分頁不閃骨架。ttl 短(30 秒)—— 這是可變的私人狀態,
 * 而且使用者可能剛在另一個分頁的閱讀器裡加了書籤。
 *
 * ⚠️ 失效寫在下面兩個變更函式裡,不是交給呼叫端記得。漏掉的症狀是「在閱讀器
 * 加了書籤,回首頁看不到」,而且無聲。
 */
export const bookmarkListCache = createQuestionStore<LectureBookmark[]>(
	() => api.get<LectureBookmark[]>("/api/lectures/bookmarks"),
	{ max: 1, ttlMs: 30_000 },
);

/** 清單只有一份,鍵是常數。 */
export const BOOKMARK_LIST_KEY = "all";

function dropBookmarkCache() {
	bookmarkListCache.invalidate(BOOKMARK_LIST_KEY);
}

/** 單一講義的書籤,依頁碼排(閱讀器左側 rail)。 */
export function listBookmarks(slug: string): Promise<LectureBookmark[]> {
	return api.get<LectureBookmark[]>(`/api/lectures/${slug}/bookmarks`);
}

/** @param page 1-based。重複加同一頁是 no-op(伺服器 INSERT OR IGNORE)。 */
export function addBookmark(slug: string, page: number): Promise<LectureBookmark> {
	return api
		.post<LectureBookmark>(`/api/lectures/${slug}/bookmarks`, { page })
		.then((r) => {
			dropBookmarkCache();
			return r;
		});
}

/** @param page 1-based。 */
export function removeBookmark(slug: string, page: number): Promise<unknown> {
	return api.del(`/api/lectures/${slug}/bookmarks/${page}`).then((r) => {
		dropBookmarkCache();
		return r;
	});
}

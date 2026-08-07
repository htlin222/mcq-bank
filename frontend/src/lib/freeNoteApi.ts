// 其他筆記(自由筆記)—— 不掛在任何題目上的私人筆記。
// 設計:docs/plans/2026-08-07-free-notes-design.md
//
// 注意:這些端點刻意**不進** sw-guards.ts 的 CACHEABLE_API。可變的私人狀態
// 被 Service Worker 快取住,使用者會看到自己剛存的東西沒有變。

import { api } from "./api";

export type FreeNoteSummary = {
	id: string;
	title: string;
	excerpt: string;
	tags: string[];
	created_at: number;
	updated_at: number;
};

export type FreeNote = {
	id: string;
	title: string;
	content_json: any;
	created_at: number;
	updated_at: number;
};

export type FreeNoteTag = { tag: string; source: "ai" | "user" };

// 一則建議。題目 / 題目筆記帶題目欄位,自由筆記帶標題 —— 呼叫端用
// targetKind 決定要讀哪一組,以及連去 /q/:id 還是 /notes/:id。
export type FreeNoteLink = {
	targetKind: "question" | "note" | "free";
	targetId: string;
	sharedTerms: string[];
	year?: number;
	number?: number;
	stem?: string;
	group?: string | null;
	title?: string;
};

export function listFreeNotes(): Promise<FreeNoteSummary[]> {
	return api
		.get<{ notes: FreeNoteSummary[] }>("/api/free-notes")
		.then((r) => r.notes ?? []);
}

export function createFreeNote(title = ""): Promise<{ id: string }> {
	return api.post<{ id: string }>("/api/free-notes", { title });
}

export function getFreeNote(id: string): Promise<FreeNote> {
	return api.get<FreeNote>(`/api/free-notes/${id}`);
}

export function saveFreeNote(
	id: string,
	patch: { title?: string; content_json?: any },
): Promise<{ updated_at: number }> {
	return api.put<{ updated_at: number }>(`/api/free-notes/${id}`, patch);
}

export function deleteFreeNote(id: string): Promise<unknown> {
	return api.del(`/api/free-notes/${id}`);
}

// 標籤獨立取得:這支可能要等 Workers AI 一兩秒(內容變了才會叫模型),
// 跟本體分開拿,詳情頁才不會為了標籤卡住。
export function getFreeNoteTags(id: string): Promise<FreeNoteTag[]> {
	return api
		.get<{ tags: FreeNoteTag[] }>(`/api/free-notes/${id}/tags`)
		.then((r) => r.tags ?? []);
}

export function addFreeNoteTag(id: string, tag: string): Promise<FreeNoteTag[]> {
	return api
		.post<{ tags: FreeNoteTag[] }>(`/api/free-notes/${id}/tags`, { tag })
		.then((r) => r.tags ?? []);
}

// 刪除在伺服器端是寫墓碑,不是刪列 —— 否則被刪掉的 AI 標籤下次內容一變就
// 又長回來(模型看同一份內容會給出同一組標籤)。
export function removeFreeNoteTag(
	id: string,
	tag: string,
): Promise<FreeNoteTag[]> {
	return api
		.del<{ tags: FreeNoteTag[] }>(
			`/api/free-notes/${id}/tags?tag=${encodeURIComponent(tag)}`,
		)
		.then((r) => r.tags ?? []);
}

export function getFreeNoteLinks(id: string): Promise<FreeNoteLink[]> {
	return api
		.get<{ links: FreeNoteLink[] }>(`/api/free-notes/${id}/links`)
		.then((r) => r.links ?? []);
}

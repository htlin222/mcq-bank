import { api } from "./api";

// One hit = the most relevant page for a selection, in a given reference source.
// slug + page deep-link to the reader via /lectures/:slug?page=N.
export type ReferenceHit = {
	slug: string;
	page: number;
	title: string;
	instructor?: string | null; // set for 複習講義 slides; null for the textbook
	snippet: string; // char(1)/char(2) marked — render via <HighlightedSnippet>
	score: number;
};

// Grouped by source so each corpus keeps its own bm25 ranking.
export type ReferenceResult = {
	textbook: ReferenceHit[]; // Wintrobe 唯讀參考書
	lecture: ReferenceHit[]; // 複習班講義 slides
	// true when a long / low-confidence selection was distilled by Workers AI
	// into canonical terms before the FTS pass (rule baseline otherwise).
	refined?: boolean;
};

// 「選字問參考資料」— POST the selected text, get the top textbook pages AND the
// top 複習講義 slides. POST (not GET) because a selection can be long.
export function lookupReference(
	text: string,
	limit = 5,
): Promise<ReferenceResult> {
	return api.post<ReferenceResult>("/api/textbook/lookup", { text, limit });
}

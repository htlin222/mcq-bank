import { api } from "./api";

// One hit = the most relevant textbook page for a selection.
// slug + page deep-link to the reader via /lectures/:slug?page=N.
export type TextbookHit = {
	slug: string;
	page: number;
	title: string;
	snippet: string; // char(1)/char(2) marked — render via <HighlightedSnippet>
	score: number;
};

// 「選字問 Wintrobe」— POST the selected text, get the top textbook pages.
// POST (not GET) because a selection can be long.
export function lookupTextbook(
	text: string,
	limit = 5,
): Promise<{ hits: TextbookHit[] }> {
	return api.post<{ hits: TextbookHit[] }>("/api/textbook/lookup", {
		text,
		limit,
	});
}

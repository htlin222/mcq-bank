// In-memory (module-level) cache of the most recent 搜尋 result set.
//
// Two jobs:
//  1. Let the Search page restore its results + scroll position instantly when
//     the user returns from opening a hit — no re-fetch, no loading flicker.
//  2. Let the single-question page walk 上一個結果 / 下一個結果 in the *search
//     result* order (across years), keyed by the same query string that the
//     result links stash in react-router history state (`fromSearch`).
//
// Intentionally NOT persisted (no sessionStorage): a full reload dropping the
// cache is fine — the question page degrades to same-year neighbours and the
// search page degrades to re-running the query.

export type Hit = {
	id: string;
	year: number;
	number: number;
	stem: string;
	group: string | null;
	snippet: string;
	times_seen?: number | null;
	last_correct?: number | null;
};

type Entry = { key: string; hits: Hit[]; scrollY: number };

let entry: Entry | null = null;

/** Store a fresh result set. Resets scroll unless it's the same query. */
export function setSearchCache(key: string, hits: Hit[]): void {
	entry = { key, hits, scrollY: entry?.key === key ? entry.scrollY : 0 };
}

/** Whole cached entry, or null. */
export function getSearchCache(): Entry | null {
	return entry;
}

/** Remember the scroll offset for a query so returning restores it. */
export function setSearchScroll(key: string, scrollY: number): void {
	if (entry && entry.key === key) entry.scrollY = scrollY;
}

/**
 * prev/next hit ids within the cached result set for `id`, or null when the
 * cache is absent / stale / doesn't contain the question (→ caller falls back
 * to same-year neighbours).
 */
export function searchNeighbors(
	key: string,
	id: string,
): { prev: string | null; next: string | null } | null {
	if (!entry || entry.key !== key) return null;
	const i = entry.hits.findIndex((h) => h.id === id);
	if (i === -1) return null;
	return {
		prev: i > 0 ? entry.hits[i - 1].id : null,
		next: i < entry.hits.length - 1 ? entry.hits[i + 1].id : null,
	};
}

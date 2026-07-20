// D1 bound-parameter budget.
//
// D1 rejects a statement carrying too many bound parameters with
// `D1_ERROR: too many SQL variables`, so anything that expands a list into
// `… IN (?, ?, …)` needs a ceiling. This was found the hard way while building
// export: a 200-id `IN` list failed outright.
//
// 90 rather than the true limit — the remainder leaves room for the
// email / year / filter parameters that ride along in the same statement.
export const D1_MAX_PARAMS = 90;

/** Split `arr` into chunks no longer than `size` (never returns empty chunks). */
export function chunkParams<T>(arr: T[], size = D1_MAX_PARAMS): T[][] {
	const n = Math.max(1, Math.floor(size));
	if (arr.length <= n) return [arr];
	const out: T[][] = [];
	for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
	return out;
}

/**
 * A comma-separated `?tags=` value → a clean, bounded list.
 *
 * The cap is the point: these lists are pasted straight into
 * `IN (${list.map(() => '?')})`, so an unbounded one is a 500 waiting for
 * whoever types enough commas. Tag filters are AND-semantics anyway — past a
 * handful the result is empty by construction, so truncating loses nothing a
 * caller could have wanted.
 */
export const MAX_TAG_FILTERS = 20;

export function parseTagList(raw: string | undefined | null): string[] {
	if (!raw) return [];
	const seen = new Set<string>();
	for (const t of raw.split(",")) {
		const s = t.trim();
		if (s) seen.add(s);
		if (seen.size >= MAX_TAG_FILTERS) break;
	}
	return [...seen];
}

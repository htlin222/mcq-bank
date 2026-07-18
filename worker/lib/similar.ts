// Merge related-question candidates from three sources into one ranked,
// de-duplicated list. Vectorize semantic neighbors rank first (by score),
// then tag-overlap rows, then BM25/FTS rows fill any remaining slots.
// Pure — no D1/Vectorize access — so it stays trivially testable.

export type SimSource = "vec" | "tag" | "fts";

type VecHit = { id: string; score: number };
type IdRow = { id: string };

export type Merged = { id: string; source: SimSource };

export function mergeSimilar(input: {
	self: string;
	vec: VecHit[];
	tag: IdRow[];
	fts: IdRow[];
	limit: number;
}): Merged[] {
	const seen = new Set<string>([input.self]);
	const out: Merged[] = [];

	const push = (id: string, source: SimSource) => {
		if (out.length >= input.limit || seen.has(id)) return;
		seen.add(id);
		out.push({ id, source });
	};

	// Highest cosine score first; callers may pass unsorted hits.
	for (const v of [...input.vec].sort((a, b) => b.score - a.score)) {
		push(v.id, "vec");
	}
	for (const t of input.tag) push(t.id, "tag");
	for (const f of input.fts) push(f.id, "fts");

	return out;
}

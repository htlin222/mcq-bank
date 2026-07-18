// Build an interleaved practice set from a pool of semantically-related
// questions. Interleaving (Rohrer & Taylor 2007) mixes topics/years rather
// than blocking them, which strengthens discrimination between confusable
// concepts. We round-robin across distinct years so the set doesn't collapse
// onto one exam year. Pure + deterministic (seeded) — trivially testable.

export type DrillHit = { id: string; year: number };

// Fisher–Yates with a seeded LCG. Deterministic so the same anchor always
// yields the same set (no Math.random — also keeps this unit-testable).
function seededShuffle<T>(arr: T[], seed: number): T[] {
	let s = seed >>> 0 || 1;
	const a = [...arr];
	for (let i = a.length - 1; i > 0; i--) {
		s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
		const j = s % (i + 1);
		[a[i], a[j]] = [a[j], a[i]];
	}
	return a;
}

export function pickInterleaved(
	hits: DrillHit[],
	opts: { anchor: string; n: number; seed: number },
): DrillHit[] {
	// De-dupe by id and drop the anchor; bucket by year preserving input order
	// (callers pass hits in relevance order, so within a year we keep it).
	const seen = new Set<string>([opts.anchor]);
	const byYear = new Map<number, DrillHit[]>();
	for (const h of hits) {
		if (seen.has(h.id)) continue;
		seen.add(h.id);
		const bucket = byYear.get(h.year);
		if (bucket) bucket.push(h);
		else byYear.set(h.year, [h]);
	}

	const years = seededShuffle([...byYear.keys()], opts.seed);
	const out: DrillHit[] = [];
	let progressed = true;
	while (out.length < opts.n && progressed) {
		progressed = false;
		for (const y of years) {
			const bucket = byYear.get(y)!;
			const next = bucket.shift();
			if (next) {
				out.push(next);
				progressed = true;
				if (out.length >= opts.n) break;
			}
		}
	}
	return out;
}

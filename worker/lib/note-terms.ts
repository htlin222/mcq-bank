// Pure helpers for 筆記關聯連結 — no D1/Vectorize access, so trivially
// testable (see note-terms.test.ts). The controlled vocabulary is the set of
// DISTINCT question_tags; matching is deterministic, so it costs zero
// Workers AI neurons.

type PMNode = {
	type?: string;
	text?: string;
	content?: PMNode[];
};

// Flatten a TipTap/ProseMirror doc to plain text. Only text nodes carry
// content we match against; block structure is irrelevant for term matching,
// so we just join text with spaces (avoids gluing "AML" onto a neighbour).
export function plainTextFromDoc(doc: unknown): string {
	const out: string[] = [];
	const walk = (n: PMNode | undefined) => {
		if (!n || typeof n !== "object") return;
		if (typeof n.text === "string") out.push(n.text);
		for (const kid of n.content ?? []) walk(kid);
	};
	try {
		walk(doc as PMNode);
	} catch {
		return "";
	}
	return out.join(" ");
}

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// A term matches when it appears in the text, with a word-boundary guard on
// any ASCII-alphanumeric edge so "MDS" does not fire inside "MDSx" while CJK
// terms (no word boundaries) still match by substring. Case-insensitive.
function termMatcher(term: string): RegExp | null {
	const t = term.trim();
	if (!t) return null;
	const left = /[A-Za-z0-9]/.test(t[0]) ? "(?<![A-Za-z0-9])" : "";
	const right = /[A-Za-z0-9]/.test(t[t.length - 1]) ? "(?![A-Za-z0-9])" : "";
	try {
		return new RegExp(left + escapeRegExp(t) + right, "i");
	} catch {
		return null;
	}
}

// Which controlled terms appear in the note text. Deduped (case-insensitive on
// the vocab's own spelling), order preserved by vocab order, capped by `max`
// so one pathological note can't explode the term set.
export function extractTerms(
	text: string,
	vocab: string[],
	opts: { max?: number } = {},
): string[] {
	const max = opts.max ?? 24;
	if (!text) return [];
	const hits: string[] = [];
	const seen = new Set<string>();
	for (const term of vocab) {
		const key = term.toLowerCase();
		if (seen.has(key)) continue;
		const re = termMatcher(term);
		if (re && re.test(text)) {
			hits.push(term);
			seen.add(key);
			if (hits.length >= max) break;
		}
	}
	return hits;
}

export type Candidate = {
	targetKind: "note" | "question";
	targetId: string;
	score: number;
	sharedTerms: string[];
};

// Merge the note-candidate and question-candidate lists into one ranked set.
// Highest score first (ties broken by id for determinism); rows below
// `minScore` are dropped (寧缺勿濫); capped to `limit` (連結密度護欄).
export function mergeTopSuggestions(
	candidates: Candidate[],
	opts: { limit: number; minScore: number },
): Candidate[] {
	return candidates
		.filter((c) => c.score >= opts.minScore && c.sharedTerms.length > 0)
		.sort(
			(a, b) =>
				b.score - a.score ||
				a.targetKind.localeCompare(b.targetKind) ||
				a.targetId.localeCompare(b.targetId),
		)
		.slice(0, opts.limit);
}

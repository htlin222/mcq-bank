// Helpers for auto-cloze: flatten a TipTap explanation doc to plain text (to
// feed the keyword extractor) and normalize the extracted term list. Pure so
// they're unit-testable without the AI binding.

type PMNode = {
	type?: string;
	text?: string;
	content?: PMNode[];
};

// Block-level types get a trailing newline so words across blocks don't merge.
const BLOCK_TYPES = new Set([
	"paragraph",
	"heading",
	"listItem",
	"blockquote",
	"codeBlock",
	"tableCell",
	"tableHeader",
]);

export function explanationPlainText(doc: unknown): string {
	const out: string[] = [];
	walk(doc as PMNode | null, out);
	return out.join("").replace(/\n{2,}/g, "\n").trim();
}

function walk(node: PMNode | null | undefined, out: string[]): void {
	if (!node || typeof node !== "object") return;
	if (typeof node.text === "string") out.push(node.text);
	if (Array.isArray(node.content)) {
		for (const child of node.content) walk(child, out);
	}
	if (node.type && BLOCK_TYPES.has(node.type)) out.push("\n");
}

// djb2 — stable fingerprint of a stored JSON blob. Used to key the 個人筆記
// cloze cache: a note has no version column, so "has the text changed?" is the
// only invalidation signal available. Same algorithm as the frontend's
// hashContent so the two agree if we ever need to compare them.
export function hashText(s: string): string {
	let h = 5381;
	for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
	return String(h >>> 0);
}

/**
 * Bump whenever the extraction prompt, the term cap, or the input window
 * changes. It rides in both cloze cache keys, so a change here invalidates
 * every cached term list instead of leaving old readers stuck with terms
 * produced by the previous prompt.
 */
export const CLOZE_PROMPT_VERSION = "2";

// Trim, drop terms shorter than 2 chars, de-dupe (first occurrence wins),
// cap at 20 so a single explanation never becomes an unusable cloze wall.
export function dedupeTerms(terms: unknown): string[] {
	if (!Array.isArray(terms)) return [];
	const seen = new Set<string>();
	const out: string[] = [];
	for (const raw of terms) {
		if (typeof raw !== "string") continue;
		const t = raw.trim();
		if (t.length < 2 || seen.has(t)) continue;
		seen.add(t);
		out.push(t);
		if (out.length >= 20) break;
	}
	return out;
}

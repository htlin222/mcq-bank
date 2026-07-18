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

// Trim, drop terms shorter than 2 chars, de-dupe (first occurrence wins),
// cap at 10 so a single explanation never becomes an unusable cloze wall.
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
		if (out.length >= 10) break;
	}
	return out;
}

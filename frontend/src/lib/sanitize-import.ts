/**
 * Allowlist-style purification of *imported* TipTap docs.
 *
 * Deliberately knows nothing about OpenEvidence's DOM — it only knows what
 * machine residue *looks like* as text. That's the point: when OE redesigns
 * and every hashed class name in oe-import.ts's selectors goes stale, these
 * rules still hold.
 *
 * Motivating damage (notes 114-027 / 114-048, imported 2026-07):
 *   • `{"text": "</h3> [[1,1"}` — OE's own answer carried a stray closing tag
 *     that their renderer escaped into visible text, plus the un-chipped half
 *     of a `[[1,1]]` citation marker. linkifyCitations() only rewrites real
 *     `markdown-article-citation-chip` spans, so bare markers sail through.
 *   • `Used under license from Wiley.` / `Feedback` — figure chrome that isn't
 *     a <button>, so stripChrome()'s CHROME_SELECTOR misses it.
 *   • A trailing `您是否想進一步了解…?` invite that sits *before* the
 *     `data-answer-end` sentinel, so dropFollowUps() can't reach it.
 *
 * SCOPE: import only. Never run this on save — a user typing `</h3>` or
 * `[[1,1]]` into their own note must keep it. RichEditor wires it into the
 * one shared external-content helper so every import path is covered.
 *
 * Kept in sync with `.claude/skills/mcq/scripts/oe_import.py`
 * (`sanitize_imported_doc`) — same three rule groups, same order.
 */

type Node = {
	type?: string;
	text?: string;
	content?: Node[];
	[k: string]: unknown;
};

// --- A. text-node scrubbing --------------------------------------------------

// Literal tag text that leaked out of a markdown renderer. Bounded tag list so
// prose like "levels <h are ..." or "a<b" is untouched.
const STRAY_TAG =
	/<\/?(?:h[1-6]|p|div|span|ul|ol|li|table|tbody|thead|tr|td|th|strong|em|b|i|br)\s*\/?>/gi;

// Numeric citation markers, complete or truncated: `[[1,1]]`, `[[1-2]`, `[[1`.
// The truncation point varies with the citation number, hence the optional tail.
const CITATION_MARKER = /\[\[\s*\d+(?:\s*[,–—-]\s*\d+)*\s*\]{0,2}/g;

// A bare `[[` left behind when the chip half was linkified away. Requires the
// next char to not start a word, so `[[wiki link]]` stays intact.
const BARE_OPEN = /\[\[(?![\p{L}\p{N}])/gu;

// The closing half, when the opening half lived inside the removed chip. Only
// at a token boundary — again so a real `[[wiki link]]` survives.
const ORPHAN_CLOSE = /(?:^|(?<=\s))\]\]/g;

// Zero-width / soft hyphen, and C0 controls other than tab & newline.
const INVISIBLE =
	/[\u200B-\u200D\uFEFF\u00AD\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;

function scrubText(text: string): string {
	return text
		.replace(STRAY_TAG, "")
		.replace(CITATION_MARKER, "")
		.replace(BARE_OPEN, "")
		.replace(ORPHAN_CLOSE, "")
		.replace(INVISIBLE, "")
		.replace(/[ \t]{2,}/g, " ");
}

// --- B. whole-block chrome ---------------------------------------------------

const CHROME_PATTERNS: RegExp[] = [
	/^Used under license from\b/i,
	/^Feedback$/i,
	/^(?:Copy|Share|Cite|Export|Print|Download)$/i,
	/^Analyzed query/i,
	/^Done$/i,
	/^Searched published medical literature\b/i,
	// Trailing "shall I go deeper?" invite the model appends to its own answer.
	// No \b after the Chinese openers — CJK isn't \w, so a boundary never
	// matches there and the whole alternation would silently never fire.
	/^(?:您是否想|你是否想|(?:Would you like|Do you want)\b).*[?？]$/i,
];

function plainText(node: Node): string {
	if (node.type === "text") return node.text || "";
	return (node.content || []).map(plainText).join("");
}

function isChromeBlock(node: Node): boolean {
	if (node.type !== "paragraph" && node.type !== "heading") return false;
	const t = plainText(node).replace(/\s+/g, " ").trim();
	return t !== "" && CHROME_PATTERNS.some((re) => re.test(t));
}

// --- C. empty-shell collapse -------------------------------------------------

// Leaf nodes that are meaningful with no `content` — never collapse these.
const VOID_TYPES = new Set([
	"image",
	"horizontalRule",
	"hardBreak",
	"mention",
	"questionRef",
]);

// A cell must always hold at least one block, or the doc fails schema
// validation and TipTap drops the whole table.
const CELL_TYPES = new Set(["tableCell", "tableHeader"]);

// Code blocks legitimately contain `</h3>` and `[[1,1]]`. Hands off.
const OPAQUE_TYPES = new Set(["codeBlock"]);

function sanitizeNode(node: Node): Node | null {
	if (node.type === "text") {
		const original = node.text || "";
		const scrubbed = scrubText(original);
		// Whitespace-only *after* scrubbing means the node held nothing but
		// residue — drop it. A node that was already whitespace-only is a real
		// separator between marks (bold + " ：" + text) and must survive.
		if (scrubbed.trim() === "" && original.trim() !== "") return null;
		return scrubbed === original ? node : { ...node, text: scrubbed };
	}

	if (node.type && OPAQUE_TYPES.has(node.type)) return node;
	if (node.type && VOID_TYPES.has(node.type)) return node;
	if (isChromeBlock(node)) return null;

	if (!Array.isArray(node.content)) return node;

	const content = node.content
		.map(sanitizeNode)
		.filter((n): n is Node => n !== null);

	if (node.type && CELL_TYPES.has(node.type)) {
		return {
			...node,
			content: content.length ? content : [{ type: "paragraph" }],
		};
	}
	if (node.type === "tableRow") {
		// Keep the row's cell count intact; drop the row only if it went fully blank.
		const blank = content.every((c) => plainText(c).trim() === "");
		return blank ? null : { ...node, content };
	}
	if (content.length === 0 && node.type !== "doc") return null;

	return { ...node, content };
}

/** Purify an imported TipTap doc. Pure — the input is never mutated. */
export function sanitizeImportedDoc<T extends Node>(doc: T): T {
	return (sanitizeNode(doc) ?? { type: "doc", content: [] }) as T;
}

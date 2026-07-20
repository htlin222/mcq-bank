// TipTap (ProseMirror) doc → Markdown / HTML / plain text.
//
// Pure, dependency-free, and shared by the export endpoint (worker/routes/
// export.ts) so every output format walks the *same* node table. The node
// coverage is the union of:
//   - scripts/build-anki.py:592-635 (the previous half-implementation:
//     doc/text/bold/italic/link/paragraph/heading/bulletList/orderedList/
//     listItem/blockquote/hardBreak/image)
//   - frontend/src/lib/tiptap-extensions.ts:14-50 (what the app can actually
//     produce: + strike, code, codeBlock, horizontalRule, highlight, table*,
//     mention, questionRef)
//
// Unknown node types degrade to their children (same semantics as
// scripts/build-anki.py:635) so a future extension never blanks a doc.
//
// Why not reuse worker/lib/cloze.ts `explanationPlainText` for docToPlainText:
// that one exists to feed a keyword extractor — it drops atom nodes (mention /
// questionRef / image carry no `text`) and collapses runs of newlines. Export
// needs @mentions and question refs to survive, and needs one newline per
// block. Different contract, so it stays as-is and we walk here instead.

import { safeImageSrc } from "./note-doc.ts";

export type RenderOpts = {
	// Rewrite an image src (absolutise, or swap for a data: URI). Return null
	// to drop the image entirely.
	imageSrc?: (src: string) => string | null;
	// Prefix for questionRef links, e.g. "https://host/q/". Omitted → plain text.
	questionRefBase?: string;
};

type PMNode = {
	type?: string;
	text?: string;
	attrs?: Record<string, any>;
	marks?: { type?: string; attrs?: Record<string, any> }[];
	content?: PMNode[];
};

function isNode(n: unknown): n is PMNode {
	return !!n && typeof n === "object" && !Array.isArray(n);
}

function kids(n: PMNode): PMNode[] {
	return Array.isArray(n.content) ? n.content.filter(isNode) : [];
}

function headingLevel(n: PMNode): number {
	const raw = Number(n.attrs?.level);
	if (!Number.isFinite(raw)) return 3;
	return Math.min(6, Math.max(1, Math.trunc(raw)));
}

// Same allowlist as worker/lib/note-doc.ts safeLinkHref, kept local because
// that one isn't exported.
function safeHref(href: unknown): string | null {
	if (typeof href !== "string") return null;
	const trimmed = href.trim();
	return /^(https?:\/\/|mailto:)/i.test(trimmed) ? trimmed.slice(0, 2000) : null;
}

function resolveImageSrc(n: PMNode, opts: RenderOpts): string | null {
	const safe = safeImageSrc(n.attrs?.src);
	if (!safe) return null;
	return opts.imageSrc ? opts.imageSrc(safe) : safe;
}

function markTypes(n: PMNode): Set<string> {
	const s = new Set<string>();
	for (const m of Array.isArray(n.marks) ? n.marks : []) {
		if (m?.type) s.add(m.type);
	}
	return s;
}

function linkHrefOf(n: PMNode): string | null {
	for (const m of Array.isArray(n.marks) ? n.marks : []) {
		if (m?.type === "link") return safeHref(m.attrs?.href);
	}
	return null;
}

// ============================================================ Markdown

export function docToMarkdown(doc: unknown, opts: RenderOpts = {}): string {
	if (!isNode(doc)) return "";
	return mdBlocks(kids(doc), opts, 0).join("\n\n").trim();
}

const MD_INLINE = new Set(["text", "hardBreak", "image", "mention", "questionRef"]);

function isInline(n: PMNode): boolean {
	return MD_INLINE.has(n.type || "");
}

// Render a list of sibling nodes as block strings. Inline nodes appearing at
// block position (loose docs do happen) are gathered into one implicit block.
function mdBlocks(nodes: PMNode[], opts: RenderOpts, depth: number): string[] {
	const out: string[] = [];
	let inlineRun: PMNode[] = [];
	const flush = () => {
		if (inlineRun.length === 0) return;
		const s = mdInline(inlineRun, opts);
		if (s) out.push(s);
		inlineRun = [];
	};
	for (const n of nodes) {
		if (isInline(n)) {
			inlineRun.push(n);
			continue;
		}
		flush();
		const s = mdBlock(n, opts, depth);
		if (s !== "") out.push(s);
	}
	flush();
	return out;
}

function mdBlock(n: PMNode, opts: RenderOpts, depth: number): string {
	switch (n.type) {
		case "paragraph":
			return mdInline(kids(n), opts);
		case "heading":
			return `${"#".repeat(headingLevel(n))} ${mdInline(kids(n), opts)}`.trim();
		case "bulletList":
		case "bullet_list":
			return mdList(n, opts, depth, false);
		case "orderedList":
		case "ordered_list":
			return mdList(n, opts, depth, true);
		case "blockquote": {
			const inner = mdBlocks(kids(n), opts, depth).join("\n\n");
			return inner
				.split("\n")
				.map((l) => (l === "" ? ">" : `> ${l}`))
				.join("\n");
		}
		case "codeBlock":
		case "code_block": {
			const lang = typeof n.attrs?.language === "string" ? n.attrs.language : "";
			return `\`\`\`${lang}\n${plainOf(kids(n))}\n\`\`\``;
		}
		case "horizontalRule":
		case "horizontal_rule":
			return "---";
		case "table":
			return mdTable(n, opts);
		default:
			// Unknown block: degrade to children (build-anki.py:635 semantics).
			return mdBlocks(kids(n), opts, depth).join("\n\n");
	}
}

function mdList(n: PMNode, opts: RenderOpts, depth: number, ordered: boolean): string {
	const startRaw = Number(n.attrs?.start);
	let idx = ordered && Number.isFinite(startRaw) ? Math.trunc(startRaw) : 1;
	const indent = "  ".repeat(depth);
	const lines: string[] = [];
	for (const item of kids(n)) {
		const marker = ordered ? `${idx++}. ` : "- ";
		const pad = " ".repeat(marker.length);
		const parts: string[] = [];
		let first = true;
		for (const child of kids(item)) {
			const isList = /^(bullet|ordered)_?[Ll]ist$/.test(child.type || "");
			if (isList) {
				const sub = mdBlock(child, opts, depth + 1);
				if (sub) parts.push(sub);
				continue;
			}
			const s = mdBlock(child, opts, depth);
			if (!s) continue;
			const prefix = first ? indent + marker : indent + pad;
			parts.push(
				s
					.split("\n")
					.map((l, i) => (i === 0 ? prefix + l : indent + pad + l))
					.join("\n"),
			);
			first = false;
		}
		if (first && parts.length === 0) parts.push(indent + marker.trimEnd());
		else if (first) parts.unshift(indent + marker.trimEnd());
		lines.push(parts.join("\n"));
	}
	return lines.join("\n");
}

function mdTable(n: PMNode, opts: RenderOpts): string {
	const rows = kids(n).filter((r) => r.type === "tableRow" || r.type === "table_row");
	if (rows.length === 0) return "";
	const cellsOf = (r: PMNode) =>
		kids(r).map((c) =>
			mdBlocks(kids(c), opts, 0)
				.join(" ")
				.replace(/\s+/g, " ")
				.replace(/\|/g, "\\|")
				.trim(),
		);
	const grid = rows.map(cellsOf);
	const width = Math.max(...grid.map((r) => r.length));
	const pad = (r: string[]) => {
		const copy = r.slice();
		while (copy.length < width) copy.push("");
		return copy;
	};
	const line = (r: string[]) => `| ${pad(r).join(" | ")} |`;
	const out = [line(grid[0]), `| ${Array(width).fill("---").join(" | ")} |`];
	for (const r of grid.slice(1)) out.push(line(r));
	return out.join("\n");
}

function mdInline(nodes: PMNode[], opts: RenderOpts): string {
	return nodes.map((n) => mdInlineOne(n, opts)).join("");
}

function mdInlineOne(n: PMNode, opts: RenderOpts): string {
	switch (n.type) {
		case "text": {
			let s = typeof n.text === "string" ? n.text : "";
			if (s === "") return "";
			const m = markTypes(n);
			// code innermost, link outermost — mirrors the HTML nesting.
			if (m.has("code")) s = `\`${s}\``;
			if (m.has("bold") || m.has("strong")) s = `**${s}**`;
			if (m.has("italic") || m.has("em")) s = `*${s}*`;
			if (m.has("strike")) s = `~~${s}~~`;
			if (m.has("highlight")) s = `==${s}==`;
			const href = linkHrefOf(n);
			if (href) s = `[${s}](${href})`;
			return s;
		}
		case "hardBreak":
		case "hard_break":
			return "  \n";
		case "image": {
			const src = resolveImageSrc(n, opts);
			if (!src) return "";
			const alt = typeof n.attrs?.alt === "string" ? n.attrs.alt : "";
			return `![${alt}](${src})`;
		}
		case "mention":
			return `@${n.attrs?.label || n.attrs?.id || ""}`;
		case "questionRef": {
			const id = String(n.attrs?.id || "");
			if (!id) return "";
			return opts.questionRefBase
				? `[@${id}](${opts.questionRefBase}${id})`
				: `@${id}`;
		}
		default:
			return mdInline(kids(n), opts);
	}
}

// ================================================================ HTML

const ESC: Record<string, string> = {
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
	"'": "&#39;",
};

export function escapeHtml(s: string): string {
	return s.replace(/[&<>"']/g, (ch) => ESC[ch]);
}

export function docToHtml(doc: unknown, opts: RenderOpts = {}): string {
	if (!isNode(doc)) return "";
	return htmlNodes(kids(doc), opts);
}

function htmlNodes(nodes: PMNode[], opts: RenderOpts): string {
	return nodes.map((n) => htmlNode(n, opts)).join("");
}

// TipTap always wraps cell content in a paragraph. Unwrap the single-paragraph
// case so `.expl p { margin }` from the shared stylesheet doesn't bloat rows.
function htmlCell(n: PMNode, opts: RenderOpts): string {
	const children = kids(n);
	if (children.length === 1 && children[0].type === "paragraph") {
		return htmlNodes(kids(children[0]), opts);
	}
	return htmlNodes(children, opts);
}

function htmlNode(n: PMNode, opts: RenderOpts): string {
	switch (n.type) {
		case "text": {
			let s = escapeHtml(typeof n.text === "string" ? n.text : "");
			if (s === "") return "";
			const m = markTypes(n);
			if (m.has("code")) s = `<code>${s}</code>`;
			if (m.has("bold") || m.has("strong")) s = `<b>${s}</b>`;
			if (m.has("italic") || m.has("em")) s = `<i>${s}</i>`;
			if (m.has("strike")) s = `<s>${s}</s>`;
			if (m.has("highlight")) s = `<mark>${s}</mark>`;
			const href = linkHrefOf(n);
			if (href) s = `<a href="${escapeHtml(href)}">${s}</a>`;
			return s;
		}
		case "paragraph":
			return `<p>${htmlNodes(kids(n), opts)}</p>`;
		case "heading": {
			const lvl = headingLevel(n);
			return `<h${lvl}>${htmlNodes(kids(n), opts)}</h${lvl}>`;
		}
		case "bulletList":
		case "bullet_list":
			return `<ul>${htmlNodes(kids(n), opts)}</ul>`;
		case "orderedList":
		case "ordered_list": {
			const startRaw = Number(n.attrs?.start);
			const start =
				Number.isFinite(startRaw) && startRaw !== 1 ? ` start="${Math.trunc(startRaw)}"` : "";
			return `<ol${start}>${htmlNodes(kids(n), opts)}</ol>`;
		}
		case "listItem":
		case "list_item":
			return `<li>${htmlNodes(kids(n), opts)}</li>`;
		case "blockquote":
			return `<blockquote>${htmlNodes(kids(n), opts)}</blockquote>`;
		case "codeBlock":
		case "code_block": {
			const lang = typeof n.attrs?.language === "string" ? n.attrs.language : "";
			const cls = lang ? ` class="language-${escapeHtml(lang)}"` : "";
			return `<pre><code${cls}>${escapeHtml(plainOf(kids(n)))}</code></pre>`;
		}
		case "horizontalRule":
		case "horizontal_rule":
			return "<hr>";
		case "hardBreak":
		case "hard_break":
			return "<br>";
		case "image": {
			const src = resolveImageSrc(n, opts);
			if (!src) return "";
			const alt = typeof n.attrs?.alt === "string" ? n.attrs.alt : "";
			const altAttr = alt ? ` alt="${escapeHtml(alt)}"` : "";
			return `<img src="${escapeHtml(src)}"${altAttr}>`;
		}
		case "table": {
			const rows = kids(n).filter((r) => r.type === "tableRow" || r.type === "table_row");
			if (rows.length === 0) return "";
			return `<table>${htmlNodes(rows, opts)}</table>`;
		}
		case "tableRow":
		case "table_row":
			return `<tr>${htmlNodes(kids(n), opts)}</tr>`;
		case "tableHeader":
		case "table_header":
			return `<th>${htmlCell(n, opts)}</th>`;
		case "tableCell":
		case "table_cell":
			return `<td>${htmlCell(n, opts)}</td>`;
		case "mention":
			return `<span class="mention">@${escapeHtml(String(n.attrs?.label || n.attrs?.id || ""))}</span>`;
		case "questionRef": {
			const id = String(n.attrs?.id || "");
			if (!id) return "";
			if (!opts.questionRefBase) return `<span class="qref">@${escapeHtml(id)}</span>`;
			return `<a class="qref" href="${escapeHtml(opts.questionRefBase + id)}">@${escapeHtml(id)}</a>`;
		}
		default:
			return htmlNodes(kids(n), opts);
	}
}

// ========================================================== plain text

export function docToPlainText(doc: unknown): string {
	if (!isNode(doc)) return "";
	return plainBlocks(kids(doc)).join("\n").trim();
}

const PLAIN_INLINE = new Set([
	"text",
	"hardBreak",
	"hard_break",
	"image",
	"mention",
	"questionRef",
]);

function plainBlocks(nodes: PMNode[]): string[] {
	const out: string[] = [];
	let run: PMNode[] = [];
	const flush = () => {
		if (run.length === 0) return;
		const s = plainOf(run).trim();
		if (s) out.push(s);
		run = [];
	};
	for (const n of nodes) {
		if (PLAIN_INLINE.has(n.type || "")) {
			run.push(n);
			continue;
		}
		flush();
		out.push(...plainBlocks(kids(n)));
	}
	flush();
	return out;
}

function plainOf(nodes: PMNode[]): string {
	return nodes
		.map((n) => {
			if (n.type === "text") return typeof n.text === "string" ? n.text : "";
			if (n.type === "hardBreak" || n.type === "hard_break") return "\n";
			if (n.type === "mention") return `@${n.attrs?.label || n.attrs?.id || ""}`;
			if (n.type === "questionRef") return `@${n.attrs?.id || ""}`;
			if (n.type === "image") return "";
			return plainOf(kids(n));
		})
		.join("");
}

// ========================================================== highlights

// Pull the user's 畫記 out of an annotated doc: the text of every span
// carrying a `highlight` mark. Adjacent highlighted text nodes belong to one
// stroke and are merged; blank strokes and duplicates are dropped.
export function extractHighlightTexts(doc: unknown): string[] {
	if (!isNode(doc)) return [];
	const out: string[] = [];
	let buf = "";
	const flush = () => {
		const s = buf.trim();
		buf = "";
		if (s && !out.includes(s)) out.push(s);
	};
	const walk = (n: PMNode) => {
		if (n.type === "text" && markTypes(n).has("highlight")) {
			buf += typeof n.text === "string" ? n.text : "";
			return;
		}
		flush();
		for (const c of kids(n)) walk(c);
	};
	for (const c of kids(doc)) walk(c);
	flush();
	return out;
}

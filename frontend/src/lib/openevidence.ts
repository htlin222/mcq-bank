// Build a blind-solving query for OpenEvidence: stem + options only, no answer.
// We send a labelled multi-option prompt so OpenEvidence can frame its reply as
// a choice analysis, not just a tangent. Truncate generously to avoid hitting
// URL length limits on either OpenEvidence or the user's browser.
export function buildOpenEvidenceUrl(data: {
	stem: string;
	options: Record<string, string>;
}): string {
	const optionLines = ["A", "B", "C", "D", "E"]
		.map((L) => (data.options[L] ? `(${L}) ${data.options[L]}` : null))
		.filter(Boolean)
		.join("\n");
	const query =
		`${data.stem}\n\nOptions:\n${optionLines}\n\nWhich option is best supported by current evidence, and why?`.slice(
			0,
			1800,
		);
	const url = new URL("https://www.openevidence.com/ask");
	url.searchParams.set("query", query);
	url.searchParams.set("configName", "prod");
	return url.toString();
}

// Build an OpenEvidence query from a free-text selection (e.g. a lecture-slide
// snippet). No options framing — just the raw text, truncated to the same URL
// budget as the question helper.
export function buildOpenEvidenceUrlFromText(text: string): string {
	const query = text.slice(0, 1800);
	const url = new URL("https://www.openevidence.com/ask");
	url.searchParams.set("query", query);
	url.searchParams.set("configName", "prod");
	return url.toString();
}

// Instruction prepended to a lecture note before handing it to OpenEvidence, so
// the reply is framed as an exam-oriented teaching breakdown rather than a raw
// echo of the note.
export const NOTE_OE_PROMPT =
	"請閱讀以下筆記內容，解析一下背景、理由、應用、實務面的考量、專科考試的出題熱區整理，多使用條列重點及表格";

// Build an OpenEvidence query from a lecture-page note: the teaching prompt at
// the head, then the note text. The prompt is always preserved; only the note
// body is truncated to stay within the URL budget. Pass a custom `prompt` to
// override the default teaching instruction (e.g. from the edit-prompt popup).
export function buildOpenEvidenceUrlForNote(
	noteText: string,
	prompt: string = NOTE_OE_PROMPT,
): string {
	const body = noteText.trim().slice(0, 4000);
	const head = prompt.trim() || NOTE_OE_PROMPT;
	const query = `${head}\n\n${body}`;
	const url = new URL("https://www.openevidence.com/ask");
	url.searchParams.set("query", query);
	url.searchParams.set("configName", "prod");
	return url.toString();
}

// Flatten a TipTap/ProseMirror doc to plain text: text nodes joined, block-level
// nodes separated by blank lines, mention nodes rendered as their label/id.
export function tiptapDocToText(doc: any): string {
	const blocks: string[] = [];
	function inline(node: any): string {
		if (!node) return "";
		if (node.type === "text") return node.text ?? "";
		if (node.type === "mention") {
			const a = node.attrs ?? {};
			const label = a.label ?? a.id ?? a.qid ?? "";
			return label ? `@${label}` : "";
		}
		if (Array.isArray(node.content)) return node.content.map(inline).join("");
		return "";
	}
	function walk(node: any) {
		if (!node) return;
		const t = node.type;
		if (t === "paragraph" || t === "heading") {
			blocks.push(node.content ? node.content.map(inline).join("") : "");
			return;
		}
		if (t === "listItem" || t === "blockquote") {
			const text = (node.content ?? []).map(inline).join("");
			if (text.trim()) blocks.push(text);
			else (node.content ?? []).forEach(walk);
			return;
		}
		if (Array.isArray(node.content)) node.content.forEach(walk);
	}
	walk(doc);
	return blocks
		.map((b) => b.trim())
		.filter(Boolean)
		.join("\n\n");
}

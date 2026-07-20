// Markdown document assembly for the in-app export (worker/routes/export.ts).
// Pure string building on top of worker/lib/tiptap-render.ts — no D1, no env,
// so the whole shape is unit-testable.

import { docToMarkdown, type RenderOpts } from "./tiptap-render.ts";

export type ExportOption = { key: string; text: string };

export type ExportItem = {
	id: string;
	year: number;
	number: number;
	group: string | null;
	stem: string;
	options: ExportOption[];
	answer: string;
	tags: string[];
	// TipTap docs. `note` / `highlights` are ALWAYS the requesting user's own —
	// worker/routes/export.ts scopes both queries by c.var.email.
	explanation: unknown | null;
	note: unknown | null;
	highlights: string[];
};

export type ExportMeta = {
	label: string;
	email: string;
	now: number;
	footnotes?: string[];
};

// Deterministic UTC+8 (the study group's timezone) — Workers have no ICU
// timezone data guarantee, so we shift the epoch rather than use toLocaleString.
export function formatTimestamp(now: number): string {
	return new Date(now + 8 * 3600_000).toISOString().slice(0, 16).replace("T", " ");
}

export function renderQuestionMarkdown(item: ExportItem, opts: RenderOpts = {}): string {
	const out: string[] = [`## ${item.id}`];

	const meta: string[] = [];
	if (item.group) meta.push(item.group);
	meta.push(`${item.year} 年第 ${item.number} 題`);
	out.push(`*${meta.join(" · ")}*`);

	out.push(item.stem.trim());

	if (item.options.length > 0) {
		out.push(item.options.map((o) => `- **${o.key}.** ${o.text}`).join("\n"));
	}

	const answerText = item.options.find((o) => o.key === item.answer)?.text;
	out.push(`**正解:${item.answer}${answerText ? `. ${answerText}` : ""}**`);

	if (item.tags.length > 0) {
		out.push(`標籤:${item.tags.map((t) => `\`${t}\``).join(" ")}`);
	}

	const expl = docToMarkdown(item.explanation, opts);
	if (expl) out.push("### 詳解", expl);

	const note = docToMarkdown(item.note, opts);
	if (note) out.push("### 我的筆記", note);

	if (item.highlights.length > 0) {
		out.push("### 我的畫記", item.highlights.map((h) => `- ${h}`).join("\n"));
	}

	return out.join("\n\n");
}

export function renderExportMarkdown(
	items: ExportItem[],
	meta: ExportMeta,
	opts: RenderOpts = {},
): string {
	const head = [
		`# ${meta.label}`,
		// The privacy requirement, made visible to whoever opens the file.
		`> 本檔含 ${meta.email} 的私人筆記與畫記,僅供本人使用,請勿轉傳。`,
		[
			`- 範圍:${meta.label}`,
			`- 匯出時間:${formatTimestamp(meta.now)} (UTC+8)`,
			`- 題數:${items.length}`,
		].join("\n"),
	].join("\n\n");

	const body = items.map((i) => renderQuestionMarkdown(i, opts)).join("\n\n---\n\n");
	const parts = [head];
	if (body) parts.push(body);
	if (meta.footnotes && meta.footnotes.length > 0) {
		parts.push(meta.footnotes.map((f) => `> ${f}`).join("\n>\n"));
	}
	return `${parts.join("\n\n---\n\n")}\n`;
}

// Chinese filenames need both an ASCII fallback (old clients) and RFC 5987
// (everyone else) or Safari shows mojibake. CR/LF are stripped from both
// halves so a filename can never inject a second response header.
export function contentDisposition(name: string): string {
	const clean = name.replace(/[\r\n]/g, "");
	const ascii = clean.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
	return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(clean)}`;
}

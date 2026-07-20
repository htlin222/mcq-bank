// Anki-importable CSV. Anki reads CSV natively and the `#…` directive header
// carries note type / deck / column mapping, which gets ~95% of what a .apkg
// would — without hand-rolling SQLite + zip inside a Worker. See
// docs/plans/2026-07-20-in-app-export.md for why .apkg is a non-goal.
//
// The HTML structure here mirrors the note templates in
// github.com/htlin222/mcq-to-anki (`templates/front.html` / `back.html`):
// those wrap the fields in `main.anki-note`, so a field only carries its own
// inner markup. Styling comes from that repo's styling.css inside Anki, which
// is why no <style> is emitted here.
//
// KNOWN CAVEAT (must stay in the UI copy): no `#guid column:` is emitted, so
// imported notes are distinct from the ones in anki-deck/*.apkg — the same
// question can end up as two cards. Merging would mean porting genanki's
// guid_for("hema-2026", id) hash. Also, Anki does not fetch remote images:
// the absolute URLs below need an authenticated browser session to render.

import { docToHtml, escapeHtml, type RenderOpts } from "./tiptap-render.ts";
import type { ExportItem } from "./export-doc.ts";

// Mirrors scripts/build-anki.py's deck/model naming so both paths land in the
// same tree of the user's collection.
const NOTETYPE = "血專";
const DECK = "血專::匯出";

const HEADER = [
	"#separator:Comma",
	"#html:true",
	`#notetype:${NOTETYPE}`,
	`#deck:${DECK}`,
	"#columns:Front,Back,Tags",
	"#tags column:3",
];

export function csvCell(v: string): string {
	if (v === "") return "";
	// Neutralise spreadsheet formula injection (Anki is unaffected; Excel /
	// Sheets are not). The leading apostrophe forces a text cell.
	const needsGuard = /^[=+\-@]/.test(v);
	const body = needsGuard ? `'${v}` : v;
	if (needsGuard || /[",\r\n]/.test(body) || /^\s|\s$/.test(body)) {
		return `"${body.replace(/"/g, '""')}"`;
	}
	return body;
}

// Anki tags cannot contain spaces (space is the separator).
export function ankiTags(item: ExportItem): string[] {
	const out: string[] = [];
	for (const t of [...item.tags, `年份-${item.year}`]) {
		const clean = t.trim().replace(/\s+/g, "_");
		if (clean && !out.includes(clean)) out.push(clean);
	}
	return out;
}

export function frontHtml(item: ExportItem): string {
	const opts = item.options
		.map(
			(o) =>
				`<li><span class="optkey">${escapeHtml(o.key)}.</span>${escapeHtml(o.text)}</li>`,
		)
		.join("");
	return (
		`<div class="qid">${escapeHtml(item.id)}</div>` +
		`<div class="stem">${escapeHtml(item.stem)}</div>` +
		(opts ? `<ul class="options">${opts}</ul>` : "")
	);
}

export function backHtml(item: ExportItem, opts: RenderOpts): string {
	const answerText = item.options.find((o) => o.key === item.answer)?.text;
	let out = `<div class="answer">正解:${escapeHtml(item.answer)}${
		answerText ? `. ${escapeHtml(answerText)}` : ""
	}</div>`;

	const expl = docToHtml(item.explanation, opts);
	if (expl) out += `<div class="expl">${expl}</div>`;

	const note = docToHtml(item.note, opts);
	if (note) out += `<div class="note">${note}</div>`;

	if (item.highlights.length > 0) {
		const lis = item.highlights.map((h) => `<li><mark>${escapeHtml(h)}</mark></li>`).join("");
		out += `<div class="hl"><ul>${lis}</ul></div>`;
	}
	return out;
}

export function renderExportCsv(
	items: ExportItem[],
	meta: { origin: string },
): string {
	// Anki never fetches relative paths, so every /img/<key> becomes absolute.
	// The bucket stays private — these URLs go through the existing worker
	// proxy and still require a Cloudflare Access session.
	const opts: RenderOpts = {
		imageSrc: (src) => (src.startsWith("/") ? meta.origin + src : src),
		questionRefBase: `${meta.origin}/q/`,
	};
	const lines = [...HEADER];
	for (const item of items) {
		lines.push(
			[
				csvCell(frontHtml(item)),
				csvCell(backHtml(item, opts)),
				csvCell(ankiTags(item).join(" ")),
			].join(","),
		);
	}
	return `${lines.join("\n")}\n`;
}

// Single-file HTML export — one self-contained document the user can open
// offline or print to PDF from the browser (which is why PDF generation in
// the Worker is a non-goal: no CJK font, no layout engine, 1 MB script cap).
//
// The markup mirrors github.com/htlin222/mcq-to-anki `templates/back.html`
// (main.anki-note > .field-front + .field-back) so the copied stylesheet in
// ./export-styles.ts applies unchanged.

import { escapeHtml, type RenderOpts } from "./tiptap-render.ts";
import { frontHtml, backHtml } from "./export-csv.ts";
import { formatTimestamp, type ExportItem, type ExportMeta } from "./export-doc.ts";
import { EXPORT_STYLES } from "./export-styles.ts";

export function renderExportHtml(
	items: ExportItem[],
	meta: ExportMeta,
	opts: RenderOpts = {},
): string {
	const label = escapeHtml(meta.label);
	const notes = items
		.map(
			(item) =>
				`<main class="anki-note">` +
				`<section class="field field-front">${frontHtml(item)}</section>` +
				`<section class="field field-back">${backHtml(item, opts)}</section>` +
				`</main>`,
		)
		.join("\n");

	const footer =
		meta.footnotes && meta.footnotes.length > 0
			? `<footer class="export-head"><ul>${meta.footnotes
					.map((f) => `<li>${escapeHtml(f)}</li>`)
					.join("")}</ul></footer>`
			: "";

	return `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${label}</title>
<style>${EXPORT_STYLES}</style>
</head>
<body>
<header class="export-head">
<h1>${label}</h1>
<p class="privacy">本檔含 ${escapeHtml(meta.email)} 的私人筆記與畫記,僅供本人使用,請勿轉傳。</p>
<ul>
<li>範圍:${label}</li>
<li>匯出時間:${formatTimestamp(meta.now)} (UTC+8)</li>
<li>題數:${items.length}</li>
</ul>
</header>
${notes}
${footer}
</body>
</html>
`;
}

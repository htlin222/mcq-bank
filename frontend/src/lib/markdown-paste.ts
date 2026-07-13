import { marked } from 'marked';

// Plain-text markdown paste support. TipTap's input rules convert `- `, `## `
// etc. as you TYPE, but pasting plain text inserts it verbatim. When the
// clipboard is plain text (no rich HTML) that clearly uses markdown block
// syntax, we parse it to HTML so lists (incl. nested), headings, blockquotes,
// hr and inline emphasis come through as real structure.

marked.setOptions({ gfm: true, breaks: false });

// Trigger only on block-level markdown, so ordinary pasted prose (a URL, a
// sentence with a stray * or #) is left as-is.
const BLOCK_MD = [
  /^[ \t]*([-*+]|\d+[.)])[ \t]+\S/m, // list item
  /^[ \t]*#{1,6}[ \t]+\S/m, // heading
  /^[ \t]*>[ \t]+\S/m, // blockquote
  /^[ \t]*(-{3,}|\*{3,}|_{3,})[ \t]*$/m, // thematic break
  /^[ \t]*```|~~~/m, // fenced code
];

export function looksLikeMarkdown(text: string): boolean {
  return BLOCK_MD.some((re) => re.test(text));
}

// Stronger signal: the clipboard text was *authored* as markdown (heading,
// bold, table, blockquote, fenced code) rather than merely containing a stray
// "- " bullet. Used to decide whether to prefer the plain-text markdown over an
// accompanying rich-HTML flavour — e.g. OpenEvidence's "Copy" puts clean
// markdown in text/plain but a flat <br>-stream in text/html, and the markdown
// round-trips into real (incl. nested) lists far more reliably. Ordinary rich
// pastes (Google Docs, Word) don't carry these markers in their text/plain, so
// their HTML is still preferred.
const AUTHORED_MD = [
  /^[ \t]*#{1,6}[ \t]+\S/m, // heading
  /\*\*[^*\n]+\*\*/, // bold
  /^[ \t]*>[ \t]+\S/m, // blockquote
  /^[ \t]*(```|~~~)/m, // fenced code
  /^[ \t]*\|.+\|[ \t]*$/m, // table row
];

export function looksLikeAuthoredMarkdown(text: string): boolean {
  return AUTHORED_MD.some((re) => re.test(text));
}

export function markdownToHtml(text: string): string {
  return marked.parse(text, { async: false }) as string;
}

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

export function markdownToHtml(text: string): string {
  return marked.parse(text, { async: false }) as string;
}

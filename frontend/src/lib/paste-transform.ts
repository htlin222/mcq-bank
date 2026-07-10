/**
 * Rebuild "flat <br> stream" HTML (e.g. OpenEvidence's Copy Text) into real
 * paragraphs before TipTap parses it.
 *
 * OpenEvidence copies its answer as a single run of inline nodes where
 * paragraphs are separated by `<br><br>` (and a stray `<br><br><br>` at the
 * top), with block content — an <img> and the <h3>References</h3><ol> — spliced
 * inline. Pasted verbatim, TipTap turns every <br> into a hard break, so each
 * separator becomes a blank line, and the malformed `<img …>caption</img>`
 * (img is a void element) tends to drop the image.
 *
 * We only touch HTML that actually uses this pattern (a run of 2+ <br>), so
 * normal Google-Docs / Word pastes with proper <p> structure pass through
 * untouched.
 */

const BLOCK_TAGS = new Set(['IMG', 'H1', 'H2', 'H3', 'H4', 'OL', 'UL', 'PRE', 'BLOCKQUOTE', 'TABLE', 'FIGURE']);

export function transformPastedHTML(html: string): string {
  if (!/(<br\s*\/?>\s*){2,}/i.test(html)) return html;

  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  const src = tpl.content;

  // `<img …>caption</img>` — img is void, so browsers already reparent the
  // caption as a sibling; nothing to do beyond letting it flow as text.

  const out = document.createElement('div');
  let para: HTMLParagraphElement | null = null;

  const flushPara = () => {
    if (para && para.textContent?.trim() === '' && !para.querySelector('img')) {
      para = null; // drop empty paragraphs (the leading <br><br><br>)
    }
    if (para) {
      out.appendChild(para);
      para = null;
    }
  };

  for (const node of Array.from(src.childNodes)) {
    // A run of one-or-more <br> ends the current paragraph.
    if (node.nodeType === Node.ELEMENT_NODE && (node as Element).tagName === 'BR') {
      flushPara();
      continue;
    }

    // Block-level elements stand on their own, outside any paragraph.
    if (node.nodeType === Node.ELEMENT_NODE && BLOCK_TAGS.has((node as Element).tagName)) {
      flushPara();
      out.appendChild(node.cloneNode(true));
      continue;
    }

    // Inline content (text, <strong>, <a>, <em>…) accumulates into a paragraph.
    if (!para) para = document.createElement('p');
    para.appendChild(node.cloneNode(true));
  }
  flushPara();

  return out.innerHTML || html;
}

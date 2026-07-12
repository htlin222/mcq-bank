// Parse a *public* OpenEvidence conversation page (fetched server-side through
// /api/oe/fetch) into its Q&A turns, so the user can pick which answer to
// import into the editor.
//
// OpenEvidence is a Next.js app that server-renders each turn. The stable
// anchors we rely on (verified against a saved conversation in
// __fixtures__/openevidence-sample.html):
//
//   • Each answer is wrapped in its own `<article>`.
//   • The user's question for a turn sits in the nearest preceding
//     `[data-testid="ask--query-bar"]` (the last, empty one is the composer).
//   • The answer prose ends at a `<div data-answer-end="true">` sentinel; the
//     citation list follows in `.ArticleReferences_references_container`.
//   • Figure thumbnails are `<button aria-label="Open figure…">` wrapping a
//     content `<img>`; reference-source favicons are `/_next/image?...favicons`.
//
// Everything is defensive: if the anchors move in a future OE redesign, we fall
// back to coarser extraction (whole article, or whole body) rather than
// returning nothing. The extracted HTML is fed through the same
// transformPastedHTML + sideloadImagesInHtml pipeline as an OE copy-paste.

export type OeTurn = { question: string; answerHtml: string };
export type OeConversation = { title: string; turns: OeTurn[] };

// Interactive / status chrome removed from an answer before import.
const CHROME_SELECTOR = [
  'button',
  'svg',
  'textarea',
  'input',
  'form',
  '[role="button"]',
  '[role="progressbar"]',
  '.MuiStepper-root',
  '.MuiStep-root',
  '.MuiStepButton-root',
  '.MuiStepLabel-root',
  '[data-testid$="Icon"]',
  '[data-testid^="ask--query-bar"]',
].join(',');

const REFS_SELECTOR = '[class*="references_container"], .brandable--references';

// The progress stepper OE renders above each answer ("Analyzed query…" → "Done").
// Text-anchored because the wrapper classes are hashed. The middle line is
// version-specific, so we also drop anything that merely *starts* with
// "Analyzed query".
const STATUS_TEXTS = new Set([
  'Analyzed query, searched for evidence',
  'Analyzed query',
  'Searched published medical literature, guidelines, FDA, CDC, and more',
  'Done',
]);

export function parseOeConversation(html: string): OeConversation {
  const doc = new DOMParser().parseFromString(html, 'text/html');

  let title = (doc.querySelector('title')?.textContent || '')
    .replace(/\s*\|\s*OpenEvidence\s*$/i, '')
    .trim();

  const articles = Array.from(doc.querySelectorAll('article'));
  if (articles.length === 0) {
    // No <article> wrappers. Only fall back to whole-body extraction if the
    // page still carries an answer-end sentinel (i.e. a real answer page whose
    // wrapper changed in a redesign). A not-found / not-public page has no
    // sentinel — return no turns so the dialog shows a friendly message rather
    // than importing the page shell as junk.
    if (!doc.querySelector('[data-answer-end]')) return { title, turns: [] };
    const body = doc.body?.cloneNode(true) as HTMLElement | undefined;
    if (body) {
      stripChrome(body);
      const refs = body.querySelector(REFS_SELECTOR);
      linkifyCitations(body, refs ? referenceUrls(refs) : []);
    }
    const answerHtml = body?.innerHTML?.trim() || '';
    return {
      title,
      turns: answerHtml ? [{ question: title || '整段內容', answerHtml }] : [],
    };
  }

  const queryBars = Array.from(
    doc.querySelectorAll('[data-testid="ask--query-bar"]'),
  );

  const turns = articles.map((article) => ({
    question: questionForArticle(article, queryBars) || '（無法擷取問題）',
    answerHtml: extractAnswerHtml(article),
  }));

  // The anonymous SSR page title is a generic "OpenEvidence" (the specific
  // title is set client-side after hydration), so fall back to the first
  // question for a meaningful dialog header.
  if (!title || title.toLowerCase() === 'openevidence') {
    title = turns[0]?.question || '';
  }

  return { title, turns };
}

// The question is the text of the nearest query-bar that appears before this
// article in document order.
function questionForArticle(article: Element, queryBars: Element[]): string {
  let best: Element | null = null;
  for (const bar of queryBars) {
    const pos = article.compareDocumentPosition(bar);
    if (pos & Node.DOCUMENT_POSITION_PRECEDING) best = bar;
    else break; // query bars are in document order; first following one ends it
  }
  return normalize(best?.textContent || '');
}

function extractAnswerHtml(article: Element): string {
  const clone = article.cloneNode(true) as HTMLElement;

  // Grab the citation list before stripping, then splice it back after the
  // body cut — so trailing feedback/follow-up chrome (which sits after it) is
  // excluded. The reference URLs (in list order) also let us turn the inline
  // citation chips into real links.
  const refs = clone.querySelector(REFS_SELECTOR);
  const refsHtml = refs ? extractReferences(refs) : '';
  const refUrls = refs ? referenceUrls(refs) : [];

  const sentinel = clone.querySelector('[data-answer-end]');
  let body: HTMLElement;
  if (sentinel) {
    const range = clone.ownerDocument.createRange();
    range.selectNodeContents(clone);
    range.setEndBefore(sentinel);
    body = clone.ownerDocument.createElement('div');
    body.appendChild(range.cloneContents());
  } else {
    // No sentinel — use the whole article, minus any trailing follow-ups.
    body = clone;
    dropFollowUps(body);
    body.querySelectorAll(REFS_SELECTOR).forEach((n) => n.remove());
  }
  stripChrome(body);
  body.querySelectorAll(REFS_SELECTOR).forEach((n) => n.remove());
  linkifyCitations(body, refUrls);

  return `${body.innerHTML}${refsHtml}`.trim();
}

// Inline citations render as `<span class="markdown-article-citation-chip">`
// showing "JournalName[1]" (the bracketed index in an aria-hidden span). Turn
// each into a real link pointing at the matching entry in the reference list,
// keeping the visible text so it reads as a proper citation instead of dead
// "JournalName[1]" noise. A chip that cites several sources ("[1][4]", "[1-2]")
// links to the first — one anchor can only carry one href — and a chip whose
// number has no matching reference degrades to plain text.
const CITATION_CHIP_SELECTOR = '[class*="markdown-article-citation-chip"]';

function linkifyCitations(root: HTMLElement, refUrls: string[]): void {
  root.querySelectorAll(CITATION_CHIP_SELECTOR).forEach((chip) => {
    const text = normalize(chip.textContent || '');
    const doc = chip.ownerDocument;
    const m = text.match(/\[(\d+)/);
    const url = m ? refUrls[parseInt(m[1], 10) - 1] || '' : '';
    if (url && text) {
      const a = doc.createElement('a');
      a.setAttribute('href', url);
      a.textContent = text;
      chip.replaceWith(a);
    } else {
      chip.replaceWith(doc.createTextNode(text));
    }
  });
}

// Reference URLs in list order, so citation index N maps to refUrls[N - 1].
function referenceUrls(refs: Element): string[] {
  return Array.from(refs.querySelectorAll(REF_ITEM_SELECTOR)).map(
    (item) => item.querySelector('a[href]')?.getAttribute('href') || '',
  );
}

// Rebuild the citation block as a clean `<h3>References</h3>` + an ordered list.
//
// OpenEvidence renders references as a MUI Accordion whose "References" label
// lives *inside the summary <button>*, and each citation as a flat pair:
//
//   <span>1.</span><div class="ArticleReferences_reference__…"> …title/subtitle… </div>
//
// Dumped verbatim, TipTap turns the standalone "1." span into its own line
// above the title — so the numbering reads as a stray line break, not a list.
// Instead we emit a real `<ol>`: each citation becomes one `<li>` (linked
// title + publication/authors as plain text), and the numeric markers are
// dropped since the list renders them. Any non-citation text that precedes the
// first reference (a leading note) is kept as a plain paragraph.
const REF_ITEM_SELECTOR = '[class*="ArticleReferences_reference__"]';

function extractReferences(refs: Element): string {
  const clone = refs.cloneNode(true) as HTMLElement;
  const headingEl = clone.querySelector('h1, h2, h3, h4, h5, h6');
  const label =
    normalize(headingEl?.textContent || '').replace(/\s*\d+\s*$/, '') ||
    'References';
  headingEl?.remove();

  const items = Array.from(clone.querySelectorAll(REF_ITEM_SELECTOR));
  if (items.length) {
    const lis = items.map(refListItem).filter(Boolean).join('');
    if (lis) {
      const lead = leadBeforeFirstItem(clone, items[0]);
      return `<h3>${escapeHtml(label)}</h3>${lead}<ol>${lis}</ol>`;
    }
  }

  // Fallback: anchors moved in a redesign — dump the stripped block as-is
  // rather than losing the citations entirely.
  stripChrome(clone);
  const inner = clone.innerHTML.trim();
  if (!inner) return '';
  return `<h3>${escapeHtml(label)}</h3>${inner}`;
}

// One citation → one `<li>`: the linked title, then journal/year/authors as
// plain text. The child spans are concatenated with spaces so an inline tag
// ("Recent"/"Guideline") doesn't glue onto the last author.
function refListItem(item: Element): string {
  const anchor = item.querySelector('a[href]');
  const href = anchor?.getAttribute('href') || '';
  const titleText = normalize(
    (anchor || item.querySelector('[class*="reference-title"]'))?.textContent ||
      '',
  );
  const subtitleEl = item.querySelector('[class*="reference-subtitle"]');
  const subtitle = subtitleEl
    ? Array.from(subtitleEl.children)
        .map((c) => normalize(c.textContent || ''))
        .filter(Boolean)
        .join(' ')
    : '';
  if (!titleText && !subtitle) return '';
  const titleHtml = href
    ? `<a href="${escapeAttr(href)}">${escapeHtml(titleText)}</a>`
    : escapeHtml(titleText);
  const rest = subtitle ? ` ${escapeHtml(subtitle)}` : '';
  return `<li>${titleHtml}${rest}</li>`;
}

// Non-citation text sitting before the first reference (a leading note) — render
// it as plain text, not swept into the list.
function leadBeforeFirstItem(clone: HTMLElement, firstItem: Element): string {
  const firstWrapper =
    firstItem.closest('[class*="ArticleReferences_references__"]') || firstItem;
  const range = clone.ownerDocument.createRange();
  range.selectNodeContents(clone);
  range.setEndBefore(firstWrapper);
  const holder = clone.ownerDocument.createElement('div');
  holder.appendChild(range.cloneContents());
  stripChrome(holder);
  const text = normalize(holder.textContent || '');
  return text ? `<p>${escapeHtml(text)}</p>` : '';
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, '&quot;');
}

function stripChrome(root: HTMLElement) {
  // 1) Unwrap figure buttons/links so their content <img> survives the button
  //    removal in the next step.
  root.querySelectorAll('button, a, [role="button"]').forEach((el) => {
    const imgs = Array.from(el.querySelectorAll('img')).filter((im) =>
      isContentImgSrc(im.getAttribute('src') || ''),
    );
    if (imgs.length) el.replaceWith(...imgs);
  });

  // 2) Remove interactive controls and the status stepper.
  root.querySelectorAll(CHROME_SELECTOR).forEach((n) => n.remove());

  // 3) Remove the leftover status text ("Analyzed query…", "Done").
  root.querySelectorAll('p, span, div, li').forEach((el) => {
    const t = normalize(el.textContent || '');
    if (STATUS_TEXTS.has(t) || (t.startsWith('Analyzed query') && t.length < 80)) {
      el.remove();
    }
  });

  // 4) Images: drop decorative favicons, resolve Next.js proxy → real src so
  //    sideloadImagesInHtml (which keys off absolute URLs) can pull them to R2.
  root.querySelectorAll('img').forEach((im) => {
    const src = im.getAttribute('src') || '';
    if (!isContentImgSrc(src)) {
      im.remove();
      return;
    }
    const real = resolveNextImage(src);
    if (real !== src) im.setAttribute('src', real);
    im.removeAttribute('srcset'); // variants all point back at the Next proxy
  });
}

// A "content" image is a real figure, not a reference-source favicon.
function isContentImgSrc(src: string): boolean {
  if (!src) return false;
  if (src.includes('favicons')) return false;
  if (/^https?:\/\//i.test(src)) return true;
  return src.startsWith('/_next/image');
}

// `/_next/image?url=<encoded>&w=…&q=…` → the underlying absolute URL.
function resolveNextImage(src: string): string {
  if (!src.startsWith('/_next/image')) return src;
  try {
    const real = new URL(src, 'https://www.openevidence.com').searchParams.get('url');
    return real || src;
  } catch {
    return src;
  }
}

// Remove a trailing "Follow-Up Questions" section, used only in the no-sentinel
// fallback path.
function dropFollowUps(root: HTMLElement) {
  for (const el of Array.from(root.querySelectorAll('*'))) {
    if (normalize(el.textContent || '') === 'Follow-Up Questions') {
      (el.closest('[class*="follow-up"]') || el.parentElement || el).remove();
      return;
    }
  }
}

function normalize(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

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
    if (body) stripChrome(body);
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
  // excluded.
  const refs = clone.querySelector(REFS_SELECTOR);
  const refsHtml = refs ? extractReferences(refs) : '';

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

  return `${body.innerHTML}${refsHtml}`.trim();
}

// Rebuild the citation block as a clean `<h3>References</h3>` + entries.
// OpenEvidence renders references as a MUI Accordion whose "References" label
// lives *inside the summary <button>* — so a blind chrome-strip would leave an
// empty heading. We capture the label first, drop the accordion heading, then
// strip the remaining chrome (per-citation toggles, feedback, favicons).
function extractReferences(refs: Element): string {
  const clone = refs.cloneNode(true) as HTMLElement;
  const headingEl = clone.querySelector('h1, h2, h3, h4, h5, h6');
  const label =
    normalize(headingEl?.textContent || '').replace(/\s*\d+\s*$/, '') ||
    'References';
  headingEl?.remove();
  stripChrome(clone);
  const inner = clone.innerHTML.trim();
  if (!inner) return '';
  return `<h3>${escapeHtml(label)}</h3>${inner}`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
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

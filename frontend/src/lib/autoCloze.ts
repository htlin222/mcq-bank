// 自動挖空 (AI cloze) — pure geometry + identity helpers.
//
// The AI's key terms are deliberately NOT stored the way 個人畫記 are: they
// never become Highlight marks in the document, so they can't be persisted to
// localStorage / the highlights table by accident, and a 畫記 edit made while
// the cloze layer is up saves normally. AnnotatableContent renders them as a
// ProseMirror decoration layer computed from these ranges instead.

export type TextRun = { pos: number; text: string };
export type Range = { from: number; to: number };

/**
 * Locate every verbatim occurrence of `terms` across the document's text runs
 * and return non-overlapping ProseMirror ranges in document order.
 *
 * Overlaps are resolved longest-match-first ("BCR-ABL1 融合基因" beats
 * "BCR-ABL1" at the same spot) so one blank never nests inside another —
 * nested decorations would produce a blank the reader can't reveal as a unit.
 */
export function termRanges(runs: TextRun[], terms: string[]): Range[] {
  const wanted = terms.filter((t) => typeof t === 'string' && t.length >= 2);
  if (wanted.length === 0) return [];
  // Longest first so the greedy overlap filter below keeps the richer term.
  const ordered = [...wanted].sort((a, b) => b.length - a.length);

  const hits: Range[] = [];
  for (const run of runs) {
    for (const term of ordered) {
      let idx = run.text.indexOf(term);
      while (idx !== -1) {
        hits.push({ from: run.pos + idx, to: run.pos + idx + term.length });
        idx = run.text.indexOf(term, idx + term.length);
      }
    }
  }

  // Document order, longer span first on a tie, then drop anything that
  // overlaps a span already taken.
  hits.sort((a, b) => a.from - b.from || b.to - a.to);
  const out: Range[] = [];
  let end = -1;
  for (const h of hits) {
    if (h.from < end) continue;
    out.push(h);
    end = h.to;
  }
  return out;
}

/**
 * Identity of the currently applied cloze layer. Reveal state is stored by
 * blank index, so it MUST be discarded when the term list changes — otherwise
 * "I already revealed blank #3" lands on a completely different blank.
 * `null` / empty terms → 'none', which is also a valid, distinct signature.
 */
export function clozeSig(terms: readonly string[] | null | undefined): string {
  if (!terms || terms.length === 0) return 'none';
  const s = terms.join('\u0000'); // NUL separator: cannot occur inside a term
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return String(h >>> 0);
}

// ── reveal state, persisted per document in sessionStorage ──
// `m` = indices of the reader's own 螢光標記 that are revealed (stable: the AI
// layer no longer changes the <mark> count). `a` = indices into the auto blanks,
// only valid while `sig` matches the current term list.
export type RevealState = { m: number[]; a: number[]; sig: string };

export function parseRevealState(raw: string | null, sig: string): RevealState {
  if (!raw) return { m: [], a: [], sig };
  try {
    const p = JSON.parse(raw);
    // Legacy shape: a bare array of mark indices, written before the AI layer
    // was split out. Keep the manual reveals, start the auto layer fresh.
    if (Array.isArray(p)) return { m: p.filter(isIdx), a: [], sig };
    if (p && typeof p === 'object') {
      const m = Array.isArray(p.m) ? p.m.filter(isIdx) : [];
      const a = p.sig === sig && Array.isArray(p.a) ? p.a.filter(isIdx) : [];
      return { m, a, sig };
    }
  } catch {
    /* corrupt — fall through to a clean slate */
  }
  return { m: [], a: [], sig };
}

function isIdx(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 0;
}

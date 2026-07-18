// Reads the reader's personal 畫記 (highlights) on 個人筆記 out of localStorage
// for the 我的畫記 category on the 收藏 page. Highlights live only here (this
// device) under `anno:note:<qid>:<hash>` keys — one per note section body —
// with value `{ h, doc }` where doc is a TipTap doc whose highlighted runs are
// text nodes carrying a `highlight` mark. See AnnotatableContent / NoteContent.

export type HlSegment = { text: string; hl: boolean };
export type HlLine = {
  segments: HlSegment[];
  ellipsisStart: boolean;
  ellipsisEnd: boolean;
};
export type HlGroup = {
  qid: string;
  year: number;
  number: number;
  lines: HlLine[]; // up to 3, windowed around the highlight
  total: number; // total highlighted lines for this question
};

type RawLine = { text: string; ranges: { start: number; end: number }[] };

const NOTE_PREFIX = 'anno:note:';
// Context window shown around the highlight in each line.
const CTX_BEFORE = 14;
const CTX_AFTER = 60;
const MAX_LEN = 170;
const MAX_LINES = 3;

// Flatten one paragraph/heading's inline content into plain text + the char
// ranges that were highlighted (adjacent/overlapping ranges merged).
function inlineToTextRanges(content: any[]): RawLine {
  let text = '';
  const ranges: { start: number; end: number }[] = [];
  for (const n of content || []) {
    if (n?.type === 'text') {
      const t = n.text || '';
      if (Array.isArray(n.marks) && n.marks.some((m: any) => m?.type === 'highlight')) {
        ranges.push({ start: text.length, end: text.length + t.length });
      }
      text += t;
    } else if (n?.type === 'hardBreak') {
      text += ' ';
    } else if (n?.type === 'mention') {
      text += n.attrs?.label ? `@${n.attrs.label}` : '';
    } else if (typeof n?.text === 'string') {
      text += n.text;
    }
  }
  ranges.sort((a, b) => a.start - b.start);
  const merged: { start: number; end: number }[] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else merged.push({ ...r });
  }
  return { text, ranges: merged };
}

// Recurse to every text-bearing block (paragraph/heading, incl. inside lists,
// blockquotes, table cells) and keep the ones that contain a highlight.
function collectLines(node: any, out: RawLine[]): void {
  if (!node) return;
  if (node.type === 'paragraph' || node.type === 'heading') {
    const line = inlineToTextRanges(node.content || []);
    if (line.ranges.length) out.push(line);
    return;
  }
  if (Array.isArray(node.content)) for (const c of node.content) collectLines(c, out);
}

// Turn a raw line into a windowed segment list centred on its highlight(s).
function windowLine(raw: RawLine): HlLine {
  const { text, ranges } = raw;
  const first = ranges[0].start;
  const last = ranges[ranges.length - 1].end;
  const start = Math.max(0, first - CTX_BEFORE);
  let end = Math.min(text.length, last + CTX_AFTER);
  if (end - start > MAX_LEN) end = Math.min(text.length, start + MAX_LEN);

  const segments: HlSegment[] = [];
  let cur = start;
  for (const r of ranges) {
    const rs = Math.max(start, r.start);
    const re = Math.min(end, r.end);
    if (re <= cur) continue;
    if (rs > cur) segments.push({ text: text.slice(cur, rs), hl: false });
    if (re > rs) segments.push({ text: text.slice(rs, re), hl: true });
    cur = re;
  }
  if (cur < end) segments.push({ text: text.slice(cur, end), hl: false });
  return { segments, ellipsisStart: start > 0, ellipsisEnd: end < text.length };
}

/** All questions with ≥1 個人筆記 highlight on this device, newest year first. */
export function loadNoteHighlights(): HlGroup[] {
  const byQid = new Map<string, RawLine[]>();
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key || !key.startsWith(NOTE_PREFIX)) continue;
    const rest = key.slice(NOTE_PREFIX.length); // "<qid>:<hash>"
    const colon = rest.indexOf(':');
    const qid = colon >= 0 ? rest.slice(0, colon) : rest;
    if (!/^\d+-\d+$/.test(qid)) continue;
    let doc: any;
    try {
      doc = JSON.parse(localStorage.getItem(key) || 'null')?.doc;
    } catch {
      continue;
    }
    if (!doc) continue;
    const lines: RawLine[] = [];
    collectLines(doc, lines);
    if (!lines.length) continue;
    const arr = byQid.get(qid) || [];
    arr.push(...lines);
    byQid.set(qid, arr);
  }

  const groups: HlGroup[] = [];
  for (const [qid, rawLines] of byQid) {
    // Stale keys from earlier note edits can linger; dedupe identical lines.
    const seen = new Set<string>();
    const uniq = rawLines.filter((l) => {
      const k = l.text + '|' + l.ranges.map((r) => `${r.start}-${r.end}`).join(',');
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    const [ys, ns] = qid.split('-');
    groups.push({
      qid,
      year: Number(ys),
      number: Number(ns),
      lines: uniq.slice(0, MAX_LINES).map(windowLine),
      total: uniq.length,
    });
  }
  groups.sort((a, b) => b.year - a.year || a.number - b.number);
  return groups;
}

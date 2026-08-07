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

type Entry = { key: string; doc: any };

// This device's localStorage highlight entries ({ h, doc, t } → doc).
function localEntries(prefix: string = NOTE_PREFIX): Entry[] {
  const out: Entry[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key || !key.startsWith(prefix)) continue;
    let doc: any;
    try {
      doc = JSON.parse(localStorage.getItem(key) || 'null')?.doc;
    } catch {
      continue;
    }
    if (doc) out.push({ key, doc });
  }
  return out;
}

// Build the display groups from a set of (key, TipTap doc) entries.
function buildGroups(entries: Entry[]): HlGroup[] {
  const byQid = new Map<string, RawLine[]>();
  for (const { key, doc } of entries) {
    if (!key.startsWith(NOTE_PREFIX)) continue;
    const rest = key.slice(NOTE_PREFIX.length); // "<qid>:<hash>"
    const colon = rest.indexOf(':');
    const qid = colon >= 0 ? rest.slice(0, colon) : rest;
    if (!/^\d+-\d+$/.test(qid)) continue;
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
    const uniq = dedupeLines(rawLines);
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

/** All questions with ≥1 個人筆記 highlight on THIS device (instant, sync). */
export function loadNoteHighlights(): HlGroup[] {
  return buildGroups(localEntries());
}

// Server rows carry the TipTap doc directly as doc_json (see highlightStore).
type ServerRow = { store_key: string; doc_json: string };

/**
 * Cross-device 我的畫記: union of this device's localStorage highlights and the
 * server's, keyed by store_key (server copy wins per key). Lets highlights made
 * on other devices show up here.
 */
export function mergeNoteHighlights(serverRows: ServerRow[]): HlGroup[] {
  return buildGroups(unionEntries(serverRows, NOTE_PREFIX));
}

// ── 其他筆記(自由筆記)上的畫記 ────────────────────────────────────────
//
// 走同一套抽行 / 開窗邏輯,只有分組鍵不同:題目畫記按 qid(可從 key 解出
// 年-題號),自由筆記按 note id —— 標題不在 key 裡,要另外查(呼叫端傳進
// 來)。所以刻意用獨立型別,而不是把 HlGroup 撐成聯集:HlGroup 的 year /
// number 對自由筆記沒有意義,硬塞會讓收藏頁到處是 undefined 檢查。
// 見 docs/plans/2026-08-07-free-notes-design.md

const FREE_PREFIX = 'anno:free:';

export type FreeHlGroup = {
  id: string; // free_notes.id
  title: string; // 由呼叫端補上(key 裡沒有)
  lines: HlLine[];
  total: number;
};

function dedupeLines(rawLines: RawLine[]): RawLine[] {
  const seen = new Set<string>();
  return rawLines.filter((l) => {
    const k = l.text + '|' + l.ranges.map((r) => `${r.start}-${r.end}`).join(',');
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// localStorage + 伺服器兩邊的畫記,以 store_key 取聯集(伺服器那份優先)。
// 兩種前綴共用這一段 —— 原本只有題目筆記時它內嵌在 mergeNoteHighlights 裡。
function unionEntries(serverRows: ServerRow[], prefix: string): Entry[] {
  const byKey = new Map<string, any>();
  for (const e of localEntries(prefix)) byKey.set(e.key, e.doc);
  for (const r of serverRows) {
    if (!r?.store_key?.startsWith(prefix)) continue;
    try {
      const doc = JSON.parse(r.doc_json);
      if (doc) byKey.set(r.store_key, doc);
    } catch {
      /* skip corrupt row */
    }
  }
  return [...byKey].map(([key, doc]) => ({ key, doc }));
}

function buildFreeGroups(entries: Entry[], titles: Map<string, string>): FreeHlGroup[] {
  const byId = new Map<string, RawLine[]>();
  for (const { key, doc } of entries) {
    if (!key.startsWith(FREE_PREFIX) || !doc) continue;
    const rest = key.slice(FREE_PREFIX.length); // "<id>:<hash>"
    const colon = rest.indexOf(':');
    const id = colon >= 0 ? rest.slice(0, colon) : rest;
    if (!id) continue;
    const lines: RawLine[] = [];
    collectLines(doc, lines);
    if (!lines.length) continue;
    byId.set(id, [...(byId.get(id) || []), ...lines]);
  }

  const groups: FreeHlGroup[] = [];
  for (const [id, rawLines] of byId) {
    // 筆記被刪掉之後,畫記可能還留在 localStorage / highlights 表裡。標題查
    // 不到就代表那則筆記已經不在了 —— 顯示一張連不到任何地方的卡片只會讓
    // 人以為系統壞了,直接略過。
    const title = titles.get(id);
    if (title === undefined) continue;
    const uniq = dedupeLines(rawLines);
    groups.push({
      id,
      title: title || '(未命名筆記)',
      lines: uniq.slice(0, MAX_LINES).map(windowLine),
      total: uniq.length,
    });
  }
  return groups;
}

/** 自由筆記上的畫記(localStorage + 伺服器聯集)。titles: id → 標題。 */
export function mergeFreeNoteHighlights(
  serverRows: ServerRow[],
  titles: Map<string, string>,
): FreeHlGroup[] {
  return buildFreeGroups(unionEntries(serverRows, FREE_PREFIX), titles);
}

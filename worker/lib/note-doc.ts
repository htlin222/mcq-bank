// Sanitize a TipTap/ProseMirror doc submitted by the `/mcq` skill
// (PUT /api/mcq/:id/note with `doc` instead of `markdown`).
//
// The skill converts HTML (an OpenEvidence answer, or MCP-generated rich
// content) to TipTap JSON client-side; this module makes sure whatever
// arrives can be safely stored and always opens in the web editor:
//
//   • node types / marks are whitelisted to the frontend extension set
//     (frontend/src/lib/tiptap-extensions.ts) — unknown nodes are dropped,
//     unknown marks stripped
//   • attrs are rebuilt from scratch (never passed through), link/image
//     URLs restricted to http(s) / mailto / our own /img/ proxy
//   • structure is normalized so ProseMirror's schema never throws: inline
//     content is wrapped in paragraphs where a block is required, empty
//     lists/tables are dropped
//
// Mention / questionRef nodes are deliberately NOT accepted from the skill:
// they'd mint notification side-effects the API path doesn't implement.

export type PMNode = {
  type?: string;
  text?: string;
  attrs?: Record<string, any>;
  marks?: Array<{ type: string; attrs?: Record<string, any> }>;
  content?: PMNode[];
};

const MAX_NODES = 10_000;

const INLINE_TYPES = new Set(['text', 'hardBreak']);

export type SanitizeResult =
  | { ok: true; doc: PMNode; images: PMNode[]; dropped: string[] }
  | { ok: false; error: string };

export function sanitizeNoteDoc(input: unknown): SanitizeResult {
  if (!input || typeof input !== 'object' || (input as PMNode).type !== 'doc') {
    return { ok: false, error: 'doc must be a TipTap document ({type:"doc"})' };
  }
  const state = { count: 0, images: [] as PMNode[], dropped: new Set<string>() };
  let blocks: PMNode[];
  try {
    blocks = sanitizeBlocks((input as PMNode).content ?? [], state);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'invalid doc' };
  }
  if (!blocks.length) return { ok: false, error: 'doc has no usable content' };
  return {
    ok: true,
    doc: { type: 'doc', content: blocks },
    images: state.images,
    dropped: [...state.dropped],
  };
}

type State = { count: number; images: PMNode[]; dropped: Set<string> };

function bump(state: State) {
  if (++state.count > MAX_NODES) throw new Error(`doc too large (max ${MAX_NODES} nodes)`);
}

// Sanitize children of a block context; stray inline nodes are gathered into
// paragraphs so the result always satisfies the editor schema.
function sanitizeBlocks(children: PMNode[], state: State): PMNode[] {
  const out: PMNode[] = [];
  let inlineRun: PMNode[] = [];
  const flush = () => {
    if (inlineRun.length) out.push({ type: 'paragraph', content: inlineRun });
    inlineRun = [];
  };
  for (const child of Array.isArray(children) ? children : []) {
    if (!child || typeof child !== 'object' || typeof child.type !== 'string') continue;
    if (INLINE_TYPES.has(child.type)) {
      const inline = sanitizeInline(child, state, false);
      if (inline) inlineRun.push(inline);
      continue;
    }
    flush();
    const block = sanitizeBlock(child, state);
    if (block) out.push(block);
  }
  flush();
  return out;
}

function sanitizeBlock(node: PMNode, state: State): PMNode | null {
  bump(state);
  switch (node.type) {
    case 'paragraph':
      return { type: 'paragraph', content: sanitizeInlines(node.content, state, false) };
    case 'heading': {
      const raw = Number(node.attrs?.level);
      const level = raw >= 1 && raw <= 3 ? Math.floor(raw) : raw > 3 ? 3 : 1;
      return {
        type: 'heading',
        attrs: { level },
        content: sanitizeInlines(node.content, state, false),
      };
    }
    case 'codeBlock': {
      // Code blocks hold plain text only — collapse children to one text node.
      const text = (node.content ?? [])
        .map((n) => (typeof n?.text === 'string' ? n.text : ''))
        .join('');
      return {
        type: 'codeBlock',
        ...(typeof node.attrs?.language === 'string'
          ? { attrs: { language: node.attrs.language.slice(0, 40) } }
          : {}),
        content: text ? [{ type: 'text', text }] : [],
      };
    }
    case 'blockquote': {
      const inner = sanitizeBlocks(node.content ?? [], state);
      return inner.length ? { type: 'blockquote', content: inner } : null;
    }
    case 'horizontalRule':
      return { type: 'horizontalRule' };
    case 'bulletList':
    case 'orderedList': {
      const items = (node.content ?? [])
        .filter((n) => n?.type === 'listItem')
        .map((n) => sanitizeListItem(n, state))
        .filter((n): n is PMNode => n !== null);
      if (!items.length) return null;
      const attrs =
        node.type === 'orderedList' && Number.isInteger(node.attrs?.start)
          ? { start: node.attrs!.start as number }
          : undefined;
      return { type: node.type, ...(attrs ? { attrs } : {}), content: items };
    }
    case 'image': {
      const src = safeImageSrc(node.attrs?.src);
      if (!src) return null;
      const attrs: Record<string, any> = { src };
      if (typeof node.attrs?.alt === 'string') attrs.alt = node.attrs.alt.slice(0, 500);
      if (typeof node.attrs?.title === 'string') attrs.title = node.attrs.title.slice(0, 500);
      const img = { type: 'image', attrs };
      state.images.push(img);
      return img;
    }
    case 'table': {
      const rows = (node.content ?? [])
        .filter((n) => n?.type === 'tableRow')
        .map((row) => sanitizeTableRow(row, state))
        .filter((n): n is PMNode => n !== null);
      return rows.length ? { type: 'table', content: rows } : null;
    }
    default:
      state.dropped.add(node.type!);
      // Unknown wrapper (e.g. a div-ish node): salvage its block children.
      if (Array.isArray(node.content) && node.content.length) {
        const inner = sanitizeBlocks(node.content, state);
        return inner.length === 1 ? inner[0] : inner.length ? { type: 'blockquote', content: inner } : null;
      }
      return null;
  }
}

function sanitizeListItem(node: PMNode, state: State): PMNode | null {
  bump(state);
  const inner = sanitizeBlocks(node.content ?? [], state);
  return inner.length ? { type: 'listItem', content: inner } : null;
}

function sanitizeTableRow(row: PMNode, state: State): PMNode | null {
  bump(state);
  const cells = (row.content ?? [])
    .filter((n) => n?.type === 'tableCell' || n?.type === 'tableHeader')
    .map((cell) => {
      bump(state);
      const inner = sanitizeBlocks(cell.content ?? [], state);
      const attrs: Record<string, any> = {};
      if (Number.isInteger(cell.attrs?.colspan) && cell.attrs!.colspan > 1)
        attrs.colspan = cell.attrs!.colspan;
      if (Number.isInteger(cell.attrs?.rowspan) && cell.attrs!.rowspan > 1)
        attrs.rowspan = cell.attrs!.rowspan;
      return {
        type: cell.type,
        ...(Object.keys(attrs).length ? { attrs } : {}),
        content: inner.length ? inner : [{ type: 'paragraph', content: [] }],
      } as PMNode;
    });
  return cells.length ? { type: 'tableRow', content: cells } : null;
}

function sanitizeInlines(
  children: PMNode[] | undefined,
  state: State,
  stripMarks: boolean,
): PMNode[] {
  return (Array.isArray(children) ? children : [])
    .map((n) => sanitizeInline(n, state, stripMarks))
    .filter((n): n is PMNode => n !== null);
}

function sanitizeInline(node: PMNode, state: State, stripMarks: boolean): PMNode | null {
  if (!node || typeof node !== 'object') return null;
  bump(state);
  if (node.type === 'hardBreak') return { type: 'hardBreak' };
  if (node.type !== 'text') {
    if (typeof node.type === 'string') state.dropped.add(node.type);
    // Salvage text from unknown inline wrappers (e.g. mention → plain label).
    const label = node.attrs?.label ?? node.attrs?.id;
    if (node.type === 'mention' && typeof label === 'string')
      return { type: 'text', text: `@${label}` };
    return null;
  }
  if (typeof node.text !== 'string' || node.text.length === 0) return null;
  const marks = stripMarks ? [] : sanitizeMarks(node.marks, state);
  return { type: 'text', text: node.text, ...(marks.length ? { marks } : {}) };
}

const SIMPLE_MARKS = new Set(['bold', 'italic', 'strike', 'code', 'highlight']);

function sanitizeMarks(
  marks: PMNode['marks'],
  state: State,
): NonNullable<PMNode['marks']> {
  const out: NonNullable<PMNode['marks']> = [];
  const seen = new Set<string>();
  for (const mark of Array.isArray(marks) ? marks : []) {
    if (!mark || typeof mark.type !== 'string' || seen.has(mark.type)) continue;
    if (SIMPLE_MARKS.has(mark.type)) {
      out.push({ type: mark.type });
      seen.add(mark.type);
    } else if (mark.type === 'link') {
      const href = safeLinkHref(mark.attrs?.href);
      if (href) {
        out.push({ type: 'link', attrs: { href, target: '_blank', rel: 'noopener noreferrer nofollow' } });
        seen.add('link');
      }
    } else {
      state.dropped.add(`mark:${mark.type}`);
    }
  }
  return out;
}

function safeLinkHref(href: unknown): string | null {
  if (typeof href !== 'string') return null;
  const trimmed = href.trim();
  if (/^(https?:\/\/|mailto:)/i.test(trimmed)) return trimmed.slice(0, 2000);
  return null;
}

// Accept external http(s) images (rewritten to R2 by the caller) and our own
// /img/ proxy paths; everything else (data:, blob:, relative) is dropped.
export function safeImageSrc(src: unknown): string | null {
  if (typeof src !== 'string') return null;
  const trimmed = src.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed.slice(0, 2000);
  if (trimmed.startsWith('/img/')) return trimmed.slice(0, 500);
  return null;
}

// External images that still need sideloading (src not yet on our proxy).
export function externalImages(images: PMNode[]): PMNode[] {
  return images.filter((img) => /^https?:\/\//i.test(String(img.attrs?.src || '')));
}

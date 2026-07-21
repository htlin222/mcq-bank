import { Hono } from 'hono';
import type { AppContext } from '../types';
import { apiKeyMiddleware } from '../lib/apikey';
import { sanitizeNoteDoc, externalImages } from '../lib/note-doc';
import { sideloadImageToR2 } from '../lib/sideload';
import { ftsQuery } from './search';

export const mcqRoutes = new Hono<AppContext>();

// Own API-key auth — this router is registered before the Access middleware
// in index.ts, so it never inherits Access gating.
mcqRoutes.use('*', apiKeyMiddleware);

// GET /api/mcq/search?q=CML — keyword lookup for the /mcq skill, so a user can
// find a question by topic instead of remembering its 年-題號. Registered
// BEFORE `/:id` (which would otherwise swallow "search" as an id). Returns only
// id / 年-題號 / group / snippet — never the answer, so the skill's answer-reveal
// flow stays intact. Same FTS behaviour as /api/search: ASCII tokens become
// prefix matches AND'd together, so short abbreviations (CML, CMV, AML) hit far
// more reliably than spelled-out disease names.
mcqRoutes.get('/search', async (c) => {
  const q = (c.req.query('q') || '').trim();
  const year = c.req.query('year');
  const limit = Math.min(parseInt(c.req.query('limit') || '20'), 50);
  if (!q) return c.json({ items: [], q });

  const params: any[] = [ftsQuery(q)];
  let yearSql = '';
  if (year) {
    yearSql = 'AND q.year = ?';
    params.push(parseInt(year));
  }
  params.push(limit);

  try {
    const { results } = await c.env.DB.prepare(
      `SELECT q.id, q.year, q.number, q."group",
              snippet(questions_fts, 1, '<<', '>>', '…', 16) AS snippet
         FROM questions q
         JOIN questions_fts f ON f.rowid = q.rowid
        WHERE questions_fts MATCH ? ${yearSql}
        ORDER BY bm25(questions_fts) ASC, q.year DESC, q.number ASC
        LIMIT ?`,
    )
      .bind(...params)
      .all();
    return c.json({ items: results, q });
  } catch (e) {
    console.warn('mcq search failed:', String(e));
    return c.json({ error: 'search failed', q }, 400);
  }
});

// GET /api/mcq/:id — read-only single question with parsed options, answer,
// and the collaborative explanation rendered to markdown. `id` is the primary
// key, e.g. "114-001" (民國 year + 3-digit number).
mcqRoutes.get('/:id', async (c) => {
  const id = c.req.param('id');

  const q = await c.env.DB.prepare(
    `SELECT id, year, number, "group", stem, options_json, answer, difficulty, source
       FROM questions WHERE id = ?`
  )
    .bind(id)
    .first<{
      id: string;
      year: number;
      number: number;
      group: string | null;
      stem: string;
      options_json: string;
      answer: string;
      difficulty: number | null;
      source: string | null;
    }>();
  if (!q) return c.json({ error: 'question not found', id }, 404);

  const exp = await c.env.DB.prepare(
    `SELECT content_json, version, updated_by, updated_at
       FROM explanations WHERE question_id = ?`
  )
    .bind(id)
    .first<{
      content_json: string;
      version: number;
      updated_by: string | null;
      updated_at: number;
    }>();

  // Personal note of the *authenticated* caller only — the email comes from
  // apiKeyMiddleware (HMAC-verified), never straight from the header, so one
  // member can never read another member's notes through this endpoint.
  const note = await c.env.DB.prepare(
    `SELECT content_json, updated_at
       FROM personal_notes WHERE user_email = ? AND question_id = ?`
  )
    .bind(c.get('email'), id)
    .first<{ content_json: string; updated_at: number }>();

  return c.json({
    id: q.id,
    year: q.year,
    number: q.number,
    group: q.group,
    difficulty: q.difficulty,
    source: q.source,
    stem: q.stem,
    options: JSON.parse(q.options_json) as Array<{ key: string; text: string }>,
    answer: q.answer,
    explanation: exp
      ? {
          markdown: tiptapToMarkdown(JSON.parse(exp.content_json)),
          version: exp.version,
          updated_by: exp.updated_by,
          updated_at: exp.updated_at,
        }
      : null,
    personal_note: note
      ? {
          markdown: tiptapToMarkdown(JSON.parse(note.content_json)),
          updated_at: note.updated_at,
        }
      : null,
  });
});

// PUT /api/mcq/:id/note — write the *caller's own* personal note. Default is
// append (existing rich content from the web editor is preserved verbatim,
// new blocks go after a horizontal rule); `mode: "replace"` swaps the whole
// doc and echoes the previous content back so it survives in the terminal.
//
// Content comes as ONE of:
//   • `markdown` — plain markdown, converted with markdownToTiptap below
//   • `doc`      — a TipTap document the skill built from HTML (--html /
//                  --oe-url). Sanitized to the web editor's node set
//                  (lib/note-doc.ts); external images are sideloaded to R2
//                  so notes don't depend on expiring hotlinks.
const NOTE_MAX_CHARS = 32_000;
const NOTE_DOC_MAX_JSON = 400_000; // sanity cap for the raw doc payload
const MAX_SIDELOAD_IMAGES = 12;

mcqRoutes.put('/:id/note', async (c) => {
  const id = c.req.param('id');
  const email = c.get('email');

  let body: { markdown?: unknown; doc?: unknown; mode?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid JSON body' }, 400);
  }
  const markdown = typeof body.markdown === 'string' ? body.markdown.trim() : '';
  const mode = body.mode === 'replace' ? 'replace' : 'append';
  if (!markdown && !body.doc)
    return c.json({ error: 'markdown or doc required' }, 400);
  if (markdown.length > NOTE_MAX_CHARS)
    return c.json({ error: `markdown too long (max ${NOTE_MAX_CHARS} chars)` }, 400);

  const warnings: string[] = [];
  let newBlocks: PMNode[];
  if (body.doc) {
    if (JSON.stringify(body.doc).length > NOTE_DOC_MAX_JSON)
      return c.json({ error: `doc too large (max ${NOTE_DOC_MAX_JSON} JSON chars)` }, 400);
    const sanitized = sanitizeNoteDoc(body.doc);
    if (!sanitized.ok) return c.json({ error: sanitized.error }, 400);
    if (sanitized.dropped.length)
      warnings.push(`dropped unsupported nodes: ${sanitized.dropped.join(', ')}`);

    // Persist hotlinked figures into R2 — mutates the image nodes in place.
    const pending = externalImages(sanitized.images);
    if (pending.length > MAX_SIDELOAD_IMAGES)
      warnings.push(
        `only first ${MAX_SIDELOAD_IMAGES} of ${pending.length} external images sideloaded`
      );
    for (const img of pending.slice(0, MAX_SIDELOAD_IMAGES)) {
      const src = String(img.attrs!.src);
      const result = await sideloadImageToR2(c.env, src, email);
      if (result.ok) img.attrs!.src = result.url;
      else warnings.push(`image kept as hotlink (${result.error}): ${src.slice(0, 120)}`);
    }
    newBlocks = sanitized.doc.content ?? [];
  } else {
    newBlocks = markdownToTiptap(markdown).content ?? [];
  }

  const exists = await c.env.DB.prepare('SELECT id FROM questions WHERE id = ?')
    .bind(id)
    .first();
  if (!exists) return c.json({ error: 'question not found', id }, 404);

  const prev = await c.env.DB.prepare(
    `SELECT content_json FROM personal_notes WHERE user_email = ? AND question_id = ?`
  )
    .bind(email, id)
    .first<{ content_json: string }>();
  let doc: PMNode;
  if (mode === 'append' && prev) {
    const prevDoc = JSON.parse(prev.content_json) as PMNode;
    doc = {
      type: 'doc',
      content: [...(prevDoc.content ?? []), { type: 'horizontalRule' }, ...newBlocks],
    };
  } else {
    doc = { type: 'doc', content: newBlocks };
  }

  const now = Date.now();
  await c.env.DB.prepare(
    `INSERT INTO personal_notes (user_email, question_id, content_json, updated_at, needs_relink)
     VALUES (?, ?, ?, ?, 1)
     ON CONFLICT(user_email, question_id) DO UPDATE SET
       content_json = excluded.content_json,
       updated_at   = excluded.updated_at,
       needs_relink = 1`
  )
    .bind(email, id, JSON.stringify(doc), now)
    .run();

  return c.json({
    ok: true,
    mode: prev ? mode : 'create',
    updated_at: now,
    note_markdown: tiptapToMarkdown(doc),
    previous_markdown:
      mode === 'replace' && prev ? tiptapToMarkdown(JSON.parse(prev.content_json)) : null,
    ...(warnings.length ? { warnings } : {}),
  });
});

// --- TipTap / ProseMirror JSON → markdown-ish plain text -------------------
type PMNode = {
  type?: string;
  text?: string;
  attrs?: Record<string, any>;
  marks?: Array<{ type: string; attrs?: Record<string, any> }>;
  content?: PMNode[];
};

// --- markdown → TipTap JSON (write path) -----------------------------------
// Only emits node types in the frontend's StarterKit set (paragraph, heading,
// lists, blockquote, codeBlock, horizontalRule) plus bold/italic/code marks,
// so the web editor can always open what the skill writes. Anything fancier
// in the input just survives as literal text.

function parseInline(text: string): PMNode[] {
  const nodes: PMNode[] = [];
  // **bold** / *italic* / `code`; unmatched markers fall through as text.
  const re = /(\*\*(.+?)\*\*|\*(.+?)\*|`(.+?)`)/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) nodes.push({ type: 'text', text: text.slice(last, m.index) });
    if (m[2] !== undefined)
      nodes.push({ type: 'text', text: m[2], marks: [{ type: 'bold' }] });
    else if (m[3] !== undefined)
      nodes.push({ type: 'text', text: m[3], marks: [{ type: 'italic' }] });
    else nodes.push({ type: 'text', text: m[4], marks: [{ type: 'code' }] });
    last = m.index + m[0].length;
  }
  if (last < text.length) nodes.push({ type: 'text', text: text.slice(last) });
  return nodes;
}

function paragraph(lines: string[]): PMNode {
  const content: PMNode[] = [];
  lines.forEach((line, i) => {
    if (i > 0) content.push({ type: 'hardBreak' });
    content.push(...parseInline(line));
  });
  return { type: 'paragraph', content };
}

function markdownToTiptap(md: string): PMNode {
  const blocks: PMNode[] = [];
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  let para: string[] = [];
  const flushPara = () => {
    if (para.length) blocks.push(paragraph(para));
    para = [];
  };

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      flushPara();
      i++;
      continue;
    }
    if (trimmed.startsWith('```')) {
      flushPara();
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) code.push(lines[i++]);
      i++; // closing fence (or EOF)
      blocks.push({
        type: 'codeBlock',
        content: code.length ? [{ type: 'text', text: code.join('\n') }] : [],
      });
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading) {
      flushPara();
      blocks.push({
        type: 'heading',
        attrs: { level: heading[1].length },
        content: parseInline(heading[2]),
      });
      i++;
      continue;
    }
    if (/^(-{3,}|\*{3,})$/.test(trimmed)) {
      flushPara();
      blocks.push({ type: 'horizontalRule' });
      i++;
      continue;
    }
    const bullet = /^[-*+]\s+(.*)$/.exec(trimmed);
    const ordered = /^\d+[.)]\s+(.*)$/.exec(trimmed);
    if (bullet || ordered) {
      flushPara();
      const listType = bullet ? 'bulletList' : 'orderedList';
      const itemRe = bullet ? /^[-*+]\s+(.*)$/ : /^\d+[.)]\s+(.*)$/;
      const items: PMNode[] = [];
      while (i < lines.length) {
        const m = itemRe.exec(lines[i].trim());
        if (!m) break;
        items.push({ type: 'listItem', content: [paragraph([m[1]])] });
        i++;
      }
      blocks.push({ type: listType, content: items });
      continue;
    }
    if (trimmed.startsWith('> ')) {
      flushPara();
      const quoted: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith('> '))
        quoted.push(lines[i++].trim().slice(2));
      blocks.push({ type: 'blockquote', content: [paragraph(quoted)] });
      continue;
    }
    para.push(trimmed);
    i++;
  }
  flushPara();
  if (!blocks.length) blocks.push(paragraph(['']));
  return { type: 'doc', content: blocks };
}

function tiptapToMarkdown(doc: PMNode): string {
  const walk = (n: PMNode | undefined): string => {
    if (!n) return '';
    const kids = (n.content ?? []).map(walk).join('');
    switch (n.type) {
      case 'doc':
        return kids;
      case 'paragraph':
        return kids + '\n\n';
      case 'text':
        return n.text ?? '';
      case 'heading':
        return '#'.repeat(n.attrs?.level ?? 1) + ' ' + kids + '\n\n';
      case 'bulletList':
      case 'orderedList':
        return kids + '\n';
      case 'listItem':
        return '- ' + kids.trim() + '\n';
      case 'hardBreak':
        return '\n';
      case 'blockquote':
        return '> ' + kids.trim() + '\n\n';
      case 'codeBlock':
        return '```\n' + kids + '\n```\n\n';
      case 'image':
        return `![](${n.attrs?.src ?? ''})\n`;
      case 'mention':
        return '@' + (n.attrs?.label ?? n.attrs?.id ?? '');
      default:
        return kids;
    }
  };
  return walk(doc).replace(/\n{3,}/g, '\n\n').trim();
}

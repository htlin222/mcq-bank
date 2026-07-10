import { Hono } from 'hono';
import type { AppContext } from '../types';
import { apiKeyMiddleware } from '../lib/apikey';

export const mcqRoutes = new Hono<AppContext>();

// Own API-key auth — this router is registered before the Access middleware
// in index.ts, so it never inherits Access gating.
mcqRoutes.use('*', apiKeyMiddleware);

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
const NOTE_MAX_CHARS = 32_000;

mcqRoutes.put('/:id/note', async (c) => {
  const id = c.req.param('id');
  const email = c.get('email');

  let body: { markdown?: unknown; mode?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid JSON body' }, 400);
  }
  const markdown = typeof body.markdown === 'string' ? body.markdown.trim() : '';
  const mode = body.mode === 'replace' ? 'replace' : 'append';
  if (!markdown) return c.json({ error: 'markdown must be a non-empty string' }, 400);
  if (markdown.length > NOTE_MAX_CHARS)
    return c.json({ error: `markdown too long (max ${NOTE_MAX_CHARS} chars)` }, 400);

  const exists = await c.env.DB.prepare('SELECT id FROM questions WHERE id = ?')
    .bind(id)
    .first();
  if (!exists) return c.json({ error: 'question not found', id }, 404);

  const prev = await c.env.DB.prepare(
    `SELECT content_json FROM personal_notes WHERE user_email = ? AND question_id = ?`
  )
    .bind(email, id)
    .first<{ content_json: string }>();

  const newBlocks = markdownToTiptap(markdown).content ?? [];
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
    `INSERT INTO personal_notes (user_email, question_id, content_json, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_email, question_id) DO UPDATE SET
       content_json = excluded.content_json,
       updated_at   = excluded.updated_at`
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

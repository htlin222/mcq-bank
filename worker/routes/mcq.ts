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
  });
});

// --- TipTap / ProseMirror JSON → markdown-ish plain text -------------------
type PMNode = {
  type?: string;
  text?: string;
  attrs?: Record<string, any>;
  content?: PMNode[];
};

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

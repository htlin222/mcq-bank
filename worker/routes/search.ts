import { Hono } from 'hono';
import type { AppContext } from '../types';

export const searchRoutes = new Hono<AppContext>();

/**
 * GET /api/search
 *   ?q=     full-text query (FTS5 syntax allowed — quotes for phrases,
 *           AND/OR/NOT operators; bare terms are AND'd by FTS5 defaults)
 *   ?year=  filter by 民國 year
 *   ?group= filter by one of the labels from config.toml [groups].list
 *   ?tags=  comma-separated tags, AND-semantics
 *   ?limit= default 30, max 100
 *   ?offset= default 0
 *
 * Returns items with snippet/highlight and bm25 rank.
 */
searchRoutes.get('/', async (c) => {
  const q = (c.req.query('q') || '').trim();
  const year = c.req.query('year');
  const group = c.req.query('group');
  const tags = c.req.query('tags');
  const limit = Math.min(parseInt(c.req.query('limit') || '30'), 100);
  const offset = parseInt(c.req.query('offset') || '0');

  if (!q && !year && !group && !tags) {
    return c.json({ items: [], total: 0, q });
  }

  const where: string[] = [];
  const params: any[] = [];
  let joinFts = '';

  if (q) {
    // Escape FTS quotes; build a permissive prefix query for partial matches.
    const safe = ftsQuery(q);
    joinFts = 'JOIN questions_fts f ON f.rowid = q.rowid';
    where.push('questions_fts MATCH ?');
    params.push(safe);
  }
  if (year) {
    where.push('q.year = ?');
    params.push(parseInt(year));
  }
  if (group) {
    where.push('q."group" = ?');
    params.push(group);
  }

  let tagJoin = '';
  if (tags) {
    const list = tags.split(',').map((t) => t.trim()).filter(Boolean);
    if (list.length > 0) {
      tagJoin = `
        JOIN (
          SELECT question_id FROM question_tags
          WHERE tag IN (${list.map(() => '?').join(',')})
          GROUP BY question_id
          HAVING COUNT(DISTINCT tag) = ?
        ) tf ON tf.question_id = q.id
      `;
      params.push(...list, list.length);
    }
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const orderSql = q
    ? 'ORDER BY bm25(questions_fts) ASC, q.year DESC, q.number ASC'
    : 'ORDER BY q.year DESC, q.number ASC';

  const snippetSelect = q
    ? `, snippet(questions_fts, 1, '<<', '>>', '…', 16) AS snippet`
    : `, '' AS snippet`;

  const sql = `
    SELECT q.id, q.year, q.number, q.stem, q."group" ${snippetSelect}
    FROM questions q
    ${joinFts}
    ${tagJoin}
    ${whereSql}
    ${orderSql}
    LIMIT ? OFFSET ?
  `;
  params.push(limit, offset);

  try {
    const { results } = await c.env.DB.prepare(sql).bind(...params).all();
    return c.json({ items: results, q });
  } catch (e) {
    // Usually FTS5 syntax the user typed; log the specifics, keep the
    // response generic so SQL/schema detail never reaches the client.
    console.warn('search failed:', String(e));
    return c.json({ error: 'search failed', q }, 400);
  }
});

/**
 * Convert user input into an FTS5-safe query.
 *
 * - Replaces stray `"` characters with spaces so user tokens never break
 *   our own phrase quoting.
 * - Pure ASCII alnum tokens get a trailing `*` for prefix matching
 *   (e.g. `AML` → `AML*` matches `AML7`).
 * - Mixed / CJK tokens are wrapped in `"..."` so FTS5 treats them as
 *   literal phrases.
 * - FTS5 operators (AND / OR / NOT / parentheses / column filters) are
 *   intentionally NOT stripped — they're useful in the search box and
 *   only operate over our indexed columns (stem / options / tags),
 *   none of which leak private data.
 *
 * Safety: the returned string is always passed via `.bind(?)` so SQL
 * injection is not possible regardless of input.
 */
export function ftsQuery(raw: string): string {
  const cleaned = raw.replace(/"/g, ' ').trim();
  if (!cleaned) return '';
  const parts = cleaned.split(/\s+/).map((t) => {
    if (/^[A-Za-z0-9_]+$/.test(t)) return `${t}*`;
    return `"${t}"`;
  });
  return parts.join(' ');
}

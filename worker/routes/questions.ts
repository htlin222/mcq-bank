import { Hono } from 'hono';
import type { AppContext, Question, Explanation } from '../types';
import { optionsToRecord } from '../lib/db';

export const questionsRoutes = new Hono<AppContext>();

// ------------------------------------------------------------
// List / filter questions
// ------------------------------------------------------------
questionsRoutes.get('/', async (c) => {
  const year = c.req.query('year');
  const group = c.req.query('group');           // '內科' | '共同'
  const tags = c.req.query('tags');             // comma-separated, AND-semantics
  const q = c.req.query('q');                   // free text in stem
  const limit = Math.min(parseInt(c.req.query('limit') || '50'), 200);
  const offset = parseInt(c.req.query('offset') || '0');

  const where: string[] = [];
  const params: any[] = [];

  if (year) {
    where.push('q.year = ?');
    params.push(parseInt(year));
  }
  if (group) {
    where.push('q."group" = ?');
    params.push(group);
  }
  if (q) {
    where.push('q.stem LIKE ?');
    params.push(`%${q}%`);
  }

  let joinSql = '';
  if (tags) {
    const tagList = tags.split(',').map((t) => t.trim()).filter(Boolean);
    if (tagList.length > 0) {
      // q must have ALL tags
      joinSql = `
        JOIN (
          SELECT question_id
          FROM question_tags
          WHERE tag IN (${tagList.map(() => '?').join(',')})
          GROUP BY question_id
          HAVING COUNT(DISTINCT tag) = ?
        ) tf ON tf.question_id = q.id
      `;
      params.push(...tagList, tagList.length);
    }
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const sql = `SELECT q.id, q.year, q.number, q.stem, q."group", q.difficulty
               FROM questions q
               ${joinSql}
               ${whereSql}
               ORDER BY q.year DESC, q.number ASC
               LIMIT ? OFFSET ?`;
  params.push(limit, offset);

  const { results } = await c.env.DB.prepare(sql).bind(...params).all();
  return c.json(results);
});

// ------------------------------------------------------------
// Get question with parsed options + explanation + tags + my_progress
// ------------------------------------------------------------
questionsRoutes.get('/:id', async (c) => {
  const id = c.req.param('id');
  const email = c.var.email;

  const question = await c.env.DB
    .prepare('SELECT * FROM questions WHERE id = ?')
    .bind(id)
    .first<Question>();

  if (!question) return c.json({ error: 'not found' }, 404);

  const explanation = await c.env.DB
    .prepare('SELECT * FROM explanations WHERE question_id = ?')
    .bind(id)
    .first<Explanation>();

  const { results: tagRows } = await c.env.DB
    .prepare('SELECT tag FROM question_tags WHERE question_id = ? ORDER BY created_at ASC')
    .bind(id)
    .all<{ tag: string }>();

  const [progress, bookmark] = await Promise.all([
    c.env.DB
      .prepare(
        'SELECT times_seen, times_correct, last_chosen, last_correct FROM review_progress WHERE user_email = ? AND question_id = ?'
      )
      .bind(email, id)
      .first<any>(),
    c.env.DB
      .prepare(
        'SELECT folder_id FROM bookmark_items WHERE user_email = ? AND question_id = ?'
      )
      .bind(email, id)
      .first<{ folder_id: string | null } | null>(),
  ]);

  const my_progress = progress || bookmark
    ? {
        times_seen: progress?.times_seen ?? 0,
        times_correct: progress?.times_correct ?? 0,
        last_chosen: progress?.last_chosen ?? null,
        last_correct: progress?.last_correct ?? null,
        bookmarked: bookmark ? 1 : 0,
        bookmark_folder_id: bookmark?.folder_id ?? null,
      }
    : null;

  return c.json({
    ...question,
    options: optionsToRecord(question.options_json),
    tags: tagRows.map((t) => t.tag),
    explanation: explanation || null,
    my_progress,
  });
});

// ------------------------------------------------------------
// Tags CRUD on a question
// ------------------------------------------------------------
questionsRoutes.post('/:id/tags', async (c) => {
  const id = c.req.param('id');
  const email = c.var.email;
  const body = await c.req.json<{ tag: string }>();
  const tag = (body.tag || '').trim();

  if (!tag) return c.json({ error: 'empty tag' }, 400);
  if (tag.length > 40) return c.json({ error: 'tag too long' }, 400);

  await c.env.DB
    .prepare(
      `INSERT INTO question_tags (question_id, tag, created_by, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(question_id, tag) DO NOTHING`
    )
    .bind(id, tag, email, Date.now())
    .run();

  return c.json({ ok: true, tag });
});

questionsRoutes.delete('/:id/tags/:tag', async (c) => {
  const id = c.req.param('id');
  const tag = decodeURIComponent(c.req.param('tag'));

  await c.env.DB
    .prepare('DELETE FROM question_tags WHERE question_id = ? AND tag = ?')
    .bind(id, tag)
    .run();

  return c.json({ ok: true });
});

// ------------------------------------------------------------
// Meta
// ------------------------------------------------------------

// Years (民國) with question counts
questionsRoutes.get('/_meta/years', async (c) => {
  const { results } = await c.env.DB
    .prepare('SELECT year, COUNT(*) as count FROM questions GROUP BY year ORDER BY year DESC')
    .all();
  return c.json(results);
});

// Groups
questionsRoutes.get('/_meta/groups', async (c) => {
  const { results } = await c.env.DB
    .prepare(
      `SELECT "group", COUNT(*) as count
       FROM questions
       WHERE "group" IS NOT NULL
       GROUP BY "group"
       ORDER BY count DESC`
    )
    .all();
  return c.json(results);
});

// Tag cloud (most-used tags)
questionsRoutes.get('/_meta/tags', async (c) => {
  const { results } = await c.env.DB
    .prepare(
      `SELECT tag, COUNT(*) as count
       FROM question_tags
       GROUP BY tag
       ORDER BY count DESC, tag ASC
       LIMIT 200`
    )
    .all();
  return c.json(results);
});

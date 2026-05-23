import { Hono } from 'hono';
import type { AppContext } from '../types';

export const bookmarksRoutes = new Hono<AppContext>();

/**
 * List my bookmarks, optionally filtered by folder.
 *   GET /api/bookmarks                  → all my bookmarks
 *   GET /api/bookmarks?folder=<id>      → items in a specific folder
 *   GET /api/bookmarks?folder=null      → uncategorized
 */
bookmarksRoutes.get('/', async (c) => {
  const email = c.var.email;
  const folder = c.req.query('folder');
  const source = c.req.query('source');

  // Alternate source: list questions where the user has a private note.
  // Same response shape as bookmarks so the existing UI renders unchanged.
  if (source === 'notes') {
    const { results } = await c.env.DB
      .prepare(
        `SELECT n.question_id AS id, NULL AS folder_id, NULL AS note,
                n.updated_at AS created_at,
                q.year, q.number, q.stem, q."group"
         FROM personal_notes n
         JOIN questions q ON q.id = n.question_id
         WHERE n.user_email = ?
         ORDER BY n.updated_at DESC`
      )
      .bind(email)
      .all();
    return c.json(results);
  }

  let where = 'b.user_email = ?';
  const params: any[] = [email];
  if (folder === 'null') {
    where += ' AND b.folder_id IS NULL';
  } else if (folder) {
    where += ' AND b.folder_id = ?';
    params.push(folder);
  }

  const { results } = await c.env.DB
    .prepare(
      `SELECT b.question_id AS id, b.folder_id, b.note, b.created_at,
              q.year, q.number, q.stem, q."group"
       FROM bookmark_items b
       JOIN questions q ON q.id = b.question_id
       WHERE ${where}
       ORDER BY b.created_at DESC`
    )
    .bind(...params)
    .all();
  return c.json(results);
});

// Toggle / set folder. PUT semantics: idempotent upsert.
//   body: { folder_id?: string | null, note?: string }
bookmarksRoutes.put('/:question_id', async (c) => {
  const email = c.var.email;
  const qid = c.req.param('question_id');
  const body = await c.req.json<{ folder_id?: string | null; note?: string }>();
  const now = Date.now();

  // Verify folder belongs to user (if provided)
  if (body.folder_id) {
    const ok = await c.env.DB
      .prepare('SELECT id FROM bookmark_folders WHERE id = ? AND user_email = ?')
      .bind(body.folder_id, email)
      .first();
    if (!ok) return c.json({ error: 'folder not yours' }, 403);
  }

  await c.env.DB
    .prepare(
      `INSERT INTO bookmark_items (user_email, question_id, folder_id, note, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_email, question_id) DO UPDATE SET
         folder_id = excluded.folder_id,
         note = COALESCE(excluded.note, note)`
    )
    .bind(email, qid, body.folder_id ?? null, body.note ?? null, now)
    .run();

  return c.json({ ok: true });
});

// Remove bookmark
bookmarksRoutes.delete('/:question_id', async (c) => {
  const email = c.var.email;
  const qid = c.req.param('question_id');
  await c.env.DB
    .prepare('DELETE FROM bookmark_items WHERE user_email = ? AND question_id = ?')
    .bind(email, qid)
    .run();
  return c.json({ ok: true });
});

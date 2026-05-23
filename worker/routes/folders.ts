import { Hono } from 'hono';
import type { AppContext } from '../types';
import { uuid } from '../lib/db';

export const foldersRoutes = new Hono<AppContext>();

// List my folders
foldersRoutes.get('/', async (c) => {
  const email = c.var.email;
  const { results } = await c.env.DB
    .prepare(
      `SELECT f.id, f.name, f.sort,
              (SELECT COUNT(*) FROM bookmark_items b
               WHERE b.user_email = f.user_email AND b.folder_id = f.id) AS item_count
       FROM bookmark_folders f
       WHERE f.user_email = ?
       ORDER BY f.sort ASC, f.created_at ASC`
    )
    .bind(email)
    .all();
  // Also surface uncategorized + has-note counts as synthetic "folders"
  const [uncat, notes] = await Promise.all([
    c.env.DB
      .prepare(
        `SELECT COUNT(*) AS n FROM bookmark_items
         WHERE user_email = ? AND folder_id IS NULL`
      )
      .bind(email)
      .first<{ n: number }>(),
    c.env.DB
      .prepare(
        `SELECT COUNT(*) AS n FROM personal_notes WHERE user_email = ?`
      )
      .bind(email)
      .first<{ n: number }>(),
  ]);
  return c.json({
    folders: results,
    uncategorized_count: uncat?.n ?? 0,
    notes_count: notes?.n ?? 0,
  });
});

// Create folder
foldersRoutes.post('/', async (c) => {
  const email = c.var.email;
  const body = await c.req.json<{ name: string; sort?: number }>();
  const name = (body.name || '').trim();
  if (!name || name.length > 40) {
    return c.json({ error: 'invalid name' }, 400);
  }
  const id = uuid();
  const now = Date.now();
  try {
    await c.env.DB
      .prepare(
        `INSERT INTO bookmark_folders (id, user_email, name, sort, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .bind(id, email, name, body.sort ?? 0, now)
      .run();
  } catch (e) {
    return c.json({ error: 'name conflict or invalid', detail: String(e) }, 409);
  }
  return c.json({ id, name });
});

// Rename / re-sort
foldersRoutes.patch('/:id', async (c) => {
  const email = c.var.email;
  const id = c.req.param('id');
  const body = await c.req.json<{ name?: string; sort?: number }>();
  const sets: string[] = [];
  const params: any[] = [];
  if (typeof body.name === 'string') {
    const name = body.name.trim();
    if (!name || name.length > 40) return c.json({ error: 'invalid name' }, 400);
    sets.push('name = ?'); params.push(name);
  }
  if (typeof body.sort === 'number') {
    sets.push('sort = ?'); params.push(body.sort);
  }
  if (sets.length === 0) return c.json({ ok: true });
  params.push(id, email);
  await c.env.DB
    .prepare(
      `UPDATE bookmark_folders SET ${sets.join(', ')} WHERE id = ? AND user_email = ?`
    )
    .bind(...params)
    .run();
  return c.json({ ok: true });
});

// Delete folder (items become uncategorized via ON DELETE SET NULL)
foldersRoutes.delete('/:id', async (c) => {
  const email = c.var.email;
  const id = c.req.param('id');
  await c.env.DB
    .prepare('DELETE FROM bookmark_folders WHERE id = ? AND user_email = ?')
    .bind(id, email)
    .run();
  return c.json({ ok: true });
});

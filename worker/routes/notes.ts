import { Hono } from 'hono';
import type { AppContext } from '../types';

export const notesRoutes = new Hono<AppContext>();

// Upsert this user's private note for a question
notesRoutes.put('/:id/note', async (c) => {
  const id = c.req.param('id');
  const email = c.var.email;
  const body = await c.req.json<{ content_json: any }>();

  const now = Date.now();
  const json = JSON.stringify(body.content_json);

  await c.env.DB
    .prepare(
      `INSERT INTO personal_notes (user_email, question_id, content_json, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_email, question_id) DO UPDATE SET
         content_json = excluded.content_json,
         updated_at   = excluded.updated_at`
    )
    .bind(email, id, json, now)
    .run();

  return c.json({ ok: true, updated_at: now });
});

// Remove this user's note
notesRoutes.delete('/:id/note', async (c) => {
  const id = c.req.param('id');
  const email = c.var.email;
  await c.env.DB
    .prepare('DELETE FROM personal_notes WHERE user_email = ? AND question_id = ?')
    .bind(email, id)
    .run();
  return c.json({ ok: true });
});

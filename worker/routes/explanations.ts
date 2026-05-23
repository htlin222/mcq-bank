import { Hono } from 'hono';
import type { AppContext, Explanation } from '../types';
import { tryLock, releaseLock, extractMentions, excerpt, uuid } from '../lib/db';

export const explanationsRoutes = new Hono<AppContext>();

// Acquire / renew edit lock
explanationsRoutes.post('/:id/explanation/lock', async (c) => {
  const id = c.req.param('id');
  const email = c.var.email;
  const result = await tryLock(c.env.DB, id, email);
  if (!result.ok) {
    return c.json(
      { error: 'locked', locked_by: result.lockedBy, until: result.until },
      423 // Locked
    );
  }
  return c.json({ ok: true, until: result.until });
});

// Release lock
explanationsRoutes.post('/:id/explanation/unlock', async (c) => {
  await releaseLock(c.env.DB, c.req.param('id'), c.var.email);
  return c.json({ ok: true });
});

// Save explanation (requires holding lock + matching version)
explanationsRoutes.put('/:id/explanation', async (c) => {
  const id = c.req.param('id');
  const email = c.var.email;
  const body = await c.req.json<{
    content_json: any;
    expected_version: number;
  }>();

  const now = Date.now();

  // Verify lock is held by this user
  const current = await c.env.DB
    .prepare('SELECT * FROM explanations WHERE question_id = ?')
    .bind(id)
    .first<Explanation>();

  if (!current) return c.json({ error: 'explanation row missing' }, 404);

  if (current.editing_by !== email || (current.editing_until ?? 0) < now) {
    return c.json({ error: 'you do not hold the lock' }, 423);
  }

  if (current.version !== body.expected_version) {
    return c.json(
      {
        error: 'version conflict',
        server_version: current.version,
        your_version: body.expected_version,
      },
      409
    );
  }

  const newJson = JSON.stringify(body.content_json);
  const newVersion = current.version + 1;

  // Atomic update + history insert
  await c.env.DB.batch([
    c.env.DB
      .prepare(
        `UPDATE explanations
         SET content_json = ?, version = ?,
             updated_by = ?, updated_at = ?,
             editing_by = NULL, editing_until = NULL
         WHERE question_id = ?`
      )
      .bind(newJson, newVersion, email, now, id),
    c.env.DB
      .prepare(
        `INSERT INTO explanation_history
         (question_id, version, content_json, updated_by, updated_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .bind(id, newVersion, newJson, email, now),
  ]);

  // Index mentions, fire notifications
  const mentioned = extractMentions(newJson);
  if (mentioned.length > 0) {
    const preview = excerpt(newJson);
    const ops = [];
    for (const m of mentioned) {
      if (m === email) continue;
      ops.push(
        c.env.DB
          .prepare(
            `INSERT INTO mentions (source_type, source_id, mentioned_email, by_email, question_id, created_at)
             VALUES ('explanation', ?, ?, ?, ?, ?)`
          )
          .bind(id, m, email, id, now)
      );
      ops.push(
        c.env.DB
          .prepare(
            `INSERT INTO notifications (id, recipient, kind, question_id, actor_email, preview, created_at)
             VALUES (?, ?, 'mention', ?, ?, ?, ?)`
          )
          .bind(uuid(), m, id, email, preview, now)
      );
    }
    if (ops.length) await c.env.DB.batch(ops);
  }

  return c.json({ ok: true, version: newVersion });
});

// History
explanationsRoutes.get('/:id/explanation/history', async (c) => {
  const id = c.req.param('id');
  const { results } = await c.env.DB
    .prepare(
      `SELECT version, updated_by, updated_at
       FROM explanation_history
       WHERE question_id = ?
       ORDER BY version DESC
       LIMIT 50`
    )
    .bind(id)
    .all();
  return c.json(results);
});

// Get a specific version (full content)
explanationsRoutes.get('/:id/explanation/history/:version', async (c) => {
  const id = c.req.param('id');
  const version = parseInt(c.req.param('version'));
  const row = await c.env.DB
    .prepare(
      `SELECT * FROM explanation_history
       WHERE question_id = ? AND version = ?`
    )
    .bind(id, version)
    .first();
  if (!row) return c.json({ error: 'not found' }, 404);
  return c.json(row);
});

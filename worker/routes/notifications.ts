import { Hono } from 'hono';
import type { AppContext } from '../types';

export const notificationsRoutes = new Hono<AppContext>();

notificationsRoutes.get('/', async (c) => {
  const email = c.var.email;
  const onlyUnread = c.req.query('unread') === '1';

  const sql = onlyUnread
    ? `SELECT n.*, u.display_name as actor_name, u.avatar_key as actor_avatar
       FROM notifications n
       LEFT JOIN users u ON u.email = n.actor_email
       WHERE n.recipient = ? AND n.read_at IS NULL
       ORDER BY n.created_at DESC LIMIT 50`
    : `SELECT n.*, u.display_name as actor_name, u.avatar_key as actor_avatar
       FROM notifications n
       LEFT JOIN users u ON u.email = n.actor_email
       WHERE n.recipient = ?
       ORDER BY n.created_at DESC LIMIT 50`;

  const { results } = await c.env.DB.prepare(sql).bind(email).all();
  return c.json(results);
});

notificationsRoutes.get('/unread-count', async (c) => {
  const email = c.var.email;
  const row = await c.env.DB
    .prepare(
      'SELECT COUNT(*) as n FROM notifications WHERE recipient = ? AND read_at IS NULL'
    )
    .bind(email)
    .first<{ n: number }>();
  return c.json({ count: row?.n ?? 0 });
});

notificationsRoutes.patch('/:id/read', async (c) => {
  const id = c.req.param('id');
  const email = c.var.email;
  await c.env.DB
    .prepare(
      'UPDATE notifications SET read_at = ? WHERE id = ? AND recipient = ? AND read_at IS NULL'
    )
    .bind(Date.now(), id, email)
    .run();
  return c.json({ ok: true });
});

notificationsRoutes.post('/read-all', async (c) => {
  const email = c.var.email;
  await c.env.DB
    .prepare(
      'UPDATE notifications SET read_at = ? WHERE recipient = ? AND read_at IS NULL'
    )
    .bind(Date.now(), email)
    .run();
  return c.json({ ok: true });
});

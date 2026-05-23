import { Hono } from 'hono';
import type { AppContext, User } from '../types';

export const usersRoutes = new Hono<AppContext>();

// List all users (used by @mention picker — fine for 20 users)
usersRoutes.get('/', async (c) => {
  const { results } = await c.env.DB
    .prepare('SELECT email, display_name, avatar_key FROM users ORDER BY display_name')
    .all<Pick<User, 'email' | 'display_name' | 'avatar_key'>>();
  return c.json(results);
});

// Who is online: anyone seen in the last 5 minutes.
// Excludes the caller (the requester knows they're online).
usersRoutes.get('/online', async (c) => {
  const me = c.var.email;
  const cutoff = Date.now() - 5 * 60 * 1000;
  const { results } = await c.env.DB
    .prepare(
      `SELECT email, display_name, avatar_key, last_seen_at
       FROM users
       WHERE last_seen_at IS NOT NULL AND last_seen_at > ? AND email <> ?
       ORDER BY last_seen_at DESC`
    )
    .bind(cutoff, me)
    .all<Pick<User, 'email' | 'display_name' | 'avatar_key'> & { last_seen_at: number }>();
  return c.json(results);
});

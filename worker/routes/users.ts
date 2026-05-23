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

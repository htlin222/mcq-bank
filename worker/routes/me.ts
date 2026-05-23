import { Hono } from 'hono';
import type { AppContext, User } from '../types';

export const meRoutes = new Hono<AppContext>();

meRoutes.get('/', async (c) => {
  const email = c.var.email;
  const user = await c.env.DB
    .prepare('SELECT * FROM users WHERE email = ?')
    .bind(email)
    .first<User>();
  return c.json(user);
});

meRoutes.patch('/', async (c) => {
  const email = c.var.email;
  const body = await c.req.json<{ display_name?: string; bio?: string }>();
  const now = Date.now();

  if (body.display_name !== undefined) {
    const name = body.display_name.trim();
    if (name.length < 1 || name.length > 50) {
      return c.json({ error: 'name must be 1-50 chars' }, 400);
    }
  }

  await c.env.DB
    .prepare(
      `UPDATE users
       SET display_name = COALESCE(?, display_name),
           bio = COALESCE(?, bio),
           updated_at = ?
       WHERE email = ?`
    )
    .bind(body.display_name ?? null, body.bio ?? null, now, email)
    .run();

  const user = await c.env.DB
    .prepare('SELECT * FROM users WHERE email = ?')
    .bind(email)
    .first<User>();

  return c.json(user);
});

meRoutes.post('/avatar', async (c) => {
  const email = c.var.email;
  const fd = await c.req.formData();
  // workers-types narrows FormData.get to `string | null`, but at runtime
  // multipart uploads come through as File (a Blob subclass). Cast.
  const file = fd.get('file') as unknown as (Blob & { type: string; size: number }) | string | null;

  if (!file || typeof file === 'string') return c.json({ error: 'no file' }, 400);
  if (file.size > 2_000_000) return c.json({ error: 'avatar must be <2MB' }, 413);
  if (!file.type.startsWith('image/')) return c.json({ error: 'not an image' }, 415);

  const ext = file.type.split('/')[1] || 'bin';
  const safeEmail = email.replace(/[^a-z0-9]/gi, '_');
  const key = `avatars/${safeEmail}.${ext}`;

  await c.env.R2.put(key, file.stream(), {
    httpMetadata: { contentType: file.type },
    customMetadata: { uploadedBy: email },
  });

  await c.env.DB
    .prepare('UPDATE users SET avatar_key = ?, updated_at = ? WHERE email = ?')
    .bind(key, Date.now(), email)
    .run();

  return c.json({ ok: true, avatar_key: key });
});

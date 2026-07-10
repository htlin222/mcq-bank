import { Hono } from 'hono';
import type { AppContext } from '../types';

export const chatRoutes = new Hono<AppContext>();

/**
 * GET /api/chat/ws — WebSocket upgrade into the ChatRoom DO.
 *
 * Auth already happened in authMiddleware (Access JWT rides the cookie on
 * same-origin WS upgrades; X-Dev-Email locally). We forward the verified
 * identity to the DO as headers — URI-encoded, since display names are
 * Chinese and header values must be ByteStrings.
 */
chatRoutes.get('/ws', async (c) => {
  if (c.req.header('Upgrade')?.toLowerCase() !== 'websocket') {
    return c.json({ error: 'expected websocket upgrade' }, 426);
  }

  const email = c.var.email;
  const row = await c.env.DB
    .prepare('SELECT display_name FROM users WHERE email = ?')
    .bind(email)
    .first<{ display_name: string }>();
  const name = row?.display_name ?? email.split('@')[0];

  const headers = new Headers(c.req.raw.headers);
  headers.set('X-Chat-Email', encodeURIComponent(email));
  headers.set('X-Chat-Name', encodeURIComponent(name));

  const stub = c.env.CHAT.get(c.env.CHAT.idFromName('lobby'));
  return stub.fetch(new Request(c.req.raw.url, {
    method: 'GET',
    headers,
  })) as unknown as Response;
});

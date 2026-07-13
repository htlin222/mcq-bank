import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppContext } from '../types';
import { isSection } from '../user-state';

// Cross-device "where you left off" per section (複習 / 全真), stored in the
// UserState Durable Object. Written fire-and-forget by the frontend route
// tracker; read when the 複習 / 全真 landing pages mount.

export const stateRoutes = new Hono<AppContext>();

function stub(c: Context<AppContext>) {
  return c.env.USER_STATE.get(c.env.USER_STATE.idFromName('main'));
}

stateRoutes.get('/', async (c) => {
  return c.json(await stub(c).getPositions(c.var.email));
});

stateRoutes.put('/:section', async (c) => {
  const section = c.req.param('section');
  if (!isSection(section)) return c.json({ error: 'unknown section' }, 400);
  const { path } = await c.req.json<{ path?: string }>();
  // In-app absolute path only — rejects protocol-relative "//host" too, so a
  // stored value can never turn the resume link into an off-site redirect.
  if (
    typeof path !== 'string' ||
    !path.startsWith('/') ||
    path.startsWith('//') ||
    path.length > 300
  ) {
    return c.json({ error: 'path must be an in-app path' }, 400);
  }
  await stub(c).setPosition(c.var.email, section, path);
  return c.json({ ok: true });
});

stateRoutes.delete('/:section', async (c) => {
  const section = c.req.param('section');
  if (!isSection(section)) return c.json({ error: 'unknown section' }, 400);
  await stub(c).clearPosition(c.var.email, section);
  return c.json({ ok: true });
});

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

// Per-year resume: the last question opened within one year. Registered
// before the /:section handlers so the two-segment path wins the match.
const YEAR_QID = /^(\d{3})-\d{3}$/;

stateRoutes.get('/years/:year', async (c) => {
  const year = Number(c.req.param('year'));
  if (!Number.isInteger(year)) return c.json({ error: 'bad year' }, 400);
  return c.json(await stub(c).getYearPosition(c.var.email, year));
});

stateRoutes.put('/years/:year', async (c) => {
  const year = Number(c.req.param('year'));
  if (!Number.isInteger(year)) return c.json({ error: 'bad year' }, 400);
  const { questionId } = await c.req.json<{ questionId?: string }>();
  // The stored id must be a real "YYY-NNN" whose year prefix matches the path,
  // so a tampered value can never point the resume link at another year.
  if (
    typeof questionId !== 'string' ||
    !YEAR_QID.test(questionId) ||
    questionId.slice(0, 3) !== String(year)
  ) {
    return c.json({ error: 'questionId must match the year' }, 400);
  }
  await stub(c).setYearPosition(c.var.email, year, questionId);
  return c.json({ ok: true });
});

stateRoutes.delete('/years/:year', async (c) => {
  const year = Number(c.req.param('year'));
  if (!Number.isInteger(year)) return c.json({ error: 'bad year' }, 400);
  await stub(c).clearYearPosition(c.var.email, year);
  return c.json({ ok: true });
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

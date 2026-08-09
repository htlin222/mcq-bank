import { Hono, type Context } from 'hono';
import type { AppContext } from '../types';
import {
  createChallenge,
  castVote,
  retractVote,
  withdrawChallenge,
  editChallengeRationale,
  getActiveChallenges,
  listChallengesForQuestion,
  listRecentChallenges,
  recomputeAndMaybeResolve,
} from '../lib/challenges';

// Routes that hang off /api/questions/:id/* — mounted under /api/questions.
export const questionChallengeRoutes = new Hono<AppContext>();

// Returns ALL active (open/contested) challenges for the question — an
// array, possibly empty. Multiple actives may coexist (one per letter).
questionChallengeRoutes.get('/:id/challenges/active', async (c) => {
  const id = c.req.param('id');
  const active = await getActiveChallenges(c.env.DB, id, c.var.email);
  return c.json(active);
});

questionChallengeRoutes.get('/:id/challenges', async (c) => {
  const id = c.req.param('id');
  const limit = Math.min(parseInt(c.req.query('limit') || '10'), 50);
  const list = await listChallengesForQuestion(c.env.DB, id, limit);
  return c.json(list);
});

questionChallengeRoutes.post('/:id/challenges', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<{
    proposed_answer: string;
    rationale_json: unknown;
  }>();
  const result = await createChallenge(
    c.env.DB,
    c.var.email,
    id,
    body.proposed_answer,
    body.rationale_json
  );
  if (!result.ok) return c.json({ error: result.error }, result.status);
  // Echo back the active rows so the client can render immediately.
  const active = await getActiveChallenges(c.env.DB, id, c.var.email);
  return c.json({ ok: true, id: result.id, active }, 201);
});

// Routes that operate on a challenge_id — mounted under /api/challenges.
export const challengesRoutes = new Hono<AppContext>();

/**
 * The question's post-mutation challenge state, echoed back with every
 * vote/retract/withdraw/rationale response.
 *
 * Without this the client had to follow each POST with GET
 * /challenges/active + GET /challenges before the banner updated — three
 * serial round trips (each one an Access-authenticated Worker invocation)
 * for a single button press, which is what made voting feel frozen. The
 * same two reads cost near-nothing here, next to the D1 binding.
 *
 * Sequential on purpose: `getActiveChallenges` lazily resolves time-based
 * transitions, so reading the list first would race a promotion into
 * neither array — the banner would vanish with no 已修正 pill to replace it.
 */
async function questionState(c: Context<AppContext>, questionId: string) {
  const active = await getActiveChallenges(c.env.DB, questionId, c.var.email);
  const recent = await listChallengesForQuestion(c.env.DB, questionId, 5);
  return { active, recent };
}

challengesRoutes.post('/:cid/votes', async (c) => {
  const cid = c.req.param('cid');
  const body = await c.req.json<{
    vote: 'agree' | 'disagree';
    comment_json?: unknown;
  }>();
  const result = await castVote(
    c.env.DB,
    c.var.email,
    cid,
    body.vote,
    body.comment_json ?? null
  );
  if (!result.ok) return c.json({ error: result.error }, result.status);
  return c.json({
    ok: true,
    status: result.status,
    resolution: result.resolution ?? null,
    ...(await questionState(c, result.question_id)),
  });
});

challengesRoutes.delete('/:cid/votes', async (c) => {
  const cid = c.req.param('cid');
  const result = await retractVote(c.env.DB, c.var.email, cid);
  if (!result.ok) return c.json({ error: result.error }, result.status);
  return c.json({
    ok: true,
    status: result.status,
    ...(await questionState(c, result.question_id)),
  });
});

// Proposer revises the rationale while the challenge is still active.
challengesRoutes.patch('/:cid/rationale', async (c) => {
  const cid = c.req.param('cid');
  const body = await c.req.json<{ rationale_json: unknown }>();
  if (body.rationale_json == null) {
    return c.json({ error: 'rationale_json is required' }, 400);
  }
  const result = await editChallengeRationale(c.env.DB, c.var.email, cid, body.rationale_json);
  if (!result.ok) return c.json({ error: result.error }, result.status);
  return c.json({
    ok: true,
    status: result.status,
    ...(await questionState(c, result.question_id)),
  });
});

challengesRoutes.post('/:cid/withdraw', async (c) => {
  const cid = c.req.param('cid');
  const result = await withdrawChallenge(c.env.DB, c.var.email, cid);
  if (!result.ok) return c.json({ error: result.error }, result.status);
  return c.json({
    ok: true,
    status: result.status,
    ...(await questionState(c, result.question_id)),
  });
});

challengesRoutes.post('/:cid/recompute', async (c) => {
  // Manual "are we there yet" — chiefly useful for cron-style sweeps and tests.
  const cid = c.req.param('cid');
  const result = await recomputeAndMaybeResolve(c.env.DB, cid);
  if (!result.ok) return c.json({ error: result.error }, result.status);
  return c.json({ ok: true, status: result.status, resolution: result.resolution ?? null });
});

// Recent challenges feed for the 答案挑戰 page. Defaults to active ones;
// pass ?include=resolved to include promoted/rejected/archived too.
challengesRoutes.get('/recent', async (c) => {
  const limit = Math.min(parseInt(c.req.query('limit') || '5'), 100);
  const include = c.req.query('include') === 'resolved';
  const statuses = include
    ? (['open', 'contested', 'promoted', 'rejected'] as const)
    : (['open', 'contested'] as const);
  const rows = await listRecentChallenges(c.env.DB, { statuses: [...statuses], limit });
  return c.json(rows);
});

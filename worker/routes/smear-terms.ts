import { Hono } from 'hono';
import type { AppContext } from '../types';
import {
  proposeTerm,
  castProposalVote,
  retractProposalVote,
  listRecentProposals,
} from '../lib/smear-proposal';

// 「這個寫法也該算對」提報與投票 —— C2。掛在 /api/smear 下,跟 routes/smear.ts
// 分成兩個檔案純粹是行數考量(smear.ts 已經 700+ 行);路徑不重疊
// (dx/:id/terms 是三段、terms/:tid/votes 是兩段、terms/recent 是一段),
// 兩個 Hono router 掛同一個 prefix 不會互相干擾。
export const smearTermsRoutes = new Hono<AppContext>();

// ---------------------------------------------------------------------------
// GET /api/smear/terms/recent —— 近期提報(跨全部 dx),給審閱 feed 用。
//
// ⚠️ 必須註冊在 /terms/:tid/votes 之前沒有必要 —— 兩者的路徑片段數不同
// (1 vs 2),Hono 不會混淆,但仍緊鄰著寫方便閱讀(同 smear.ts 的慣例)。
// ---------------------------------------------------------------------------
smearTermsRoutes.get('/terms/recent', async (c) => {
  const email = c.var.email;
  const limitRaw = Number(c.req.query('limit'));
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 30;
  const items = await listRecentProposals(c.env.DB, email, limit);
  return c.json({ items });
});

// ---------------------------------------------------------------------------
// POST /api/smear/dx/:id/terms —— 提報「這個寫法也該算對」
// ---------------------------------------------------------------------------
smearTermsRoutes.post('/dx/:id/terms', async (c) => {
  const dxId = c.req.param('id');
  const email = c.var.email;
  const body = await c.req
    .json<{ text?: unknown; tier?: unknown; form?: unknown; rationale?: unknown }>()
    .catch(() => ({}) as Record<string, never>);

  const result = await proposeTerm(c.env.DB, dxId, email, body);
  if (!result.ok) {
    return c.json(
      { error: result.error, existingTermId: result.existingTermId },
      result.status,
    );
  }
  return c.json({ term: result.term }, 201);
});

// ---------------------------------------------------------------------------
// POST /api/smear/terms/:tid/votes —— 投票(同意/反對),可改票
// ---------------------------------------------------------------------------
smearTermsRoutes.post('/terms/:tid/votes', async (c) => {
  const tid = c.req.param('tid');
  const email = c.var.email;
  const body = await c.req.json<{ agree?: unknown }>().catch(() => ({}) as Record<string, never>);
  if (typeof body.agree !== 'boolean') {
    return c.json({ error: 'agree must be a boolean' }, 400);
  }

  const result = await castProposalVote(c.env.DB, email, tid, body.agree);
  if (!result.ok) return c.json({ error: result.error }, result.status);
  return c.json({ term: result.term, tally: result.tally, justResolved: result.justResolved });
});

// ---------------------------------------------------------------------------
// DELETE /api/smear/terms/:tid/votes —— 收回自己的票
// ---------------------------------------------------------------------------
smearTermsRoutes.delete('/terms/:tid/votes', async (c) => {
  const tid = c.req.param('tid');
  const email = c.var.email;

  const result = await retractProposalVote(c.env.DB, email, tid);
  if (!result.ok) return c.json({ error: result.error }, result.status);
  return c.json({ term: result.term, tally: result.tally, justResolved: result.justResolved });
});

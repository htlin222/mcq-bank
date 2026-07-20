import { Hono } from 'hono';
import type { AppContext } from '../types';
import { uuid } from '../lib/db';

// 「有幫助」訊號。掛在 /api/comments —— POST / DELETE /api/comments/:cid/helpful
//
// 形狀鏡射 worker/routes/challenges.ts 的 /:cid/votes,但刻意不共用
// challenge_votes:挑戰是「決議」(會改題目答案),helpful 是「品質訊號」
// (只影響排序),共用一張表只會弄髒狀態機。
//
// target_type 目前只有 'comment'。共筆詳解刻意不投票 —— 詳解是單列可覆寫的
// 活文件,票會活得比它背書的內容久,變成誤導訊號。
export const helpfulRoutes = new Hono<AppContext>();

helpfulRoutes.post('/:cid/helpful', async (c) => {
  const cid = c.req.param('cid');
  const email = c.var.email;
  const now = Date.now();

  const target = await c.env.DB.prepare(
    'SELECT author_email, question_id FROM comments WHERE id = ? AND deleted_at IS NULL'
  )
    .bind(cid)
    .first<{ author_email: string; question_id: string }>();
  if (!target) return c.json({ error: 'not found' }, 404);

  // 禁止自投,沿用 worker/lib/challenges.ts 對提案人的既有立場。
  if (target.author_email === email) {
    return c.json({ error: 'cannot mark your own comment helpful' }, 403);
  }

  // PK 衝突即冪等:重複投票不重複計數,也不算「首次」。
  const res = await c.env.DB.prepare(
    `INSERT INTO helpful_votes (user_email, target_type, target_id, created_at)
     VALUES (?, 'comment', ?, ?)
     ON CONFLICT(user_email, target_type, target_id) DO NOTHING`
  )
    .bind(email, cid, now)
    .run();

  if ((res.meta?.changes ?? 0) > 0) {
    await maybeNotifyFirstHelpful(c.env.DB, { cid, target, now });
  }

  return c.json({
    ok: true,
    helpful_count: await helpfulCount(c.env.DB, cid),
    voted_by_me: true,
  });
});

helpfulRoutes.delete('/:cid/helpful', async (c) => {
  const cid = c.req.param('cid');
  await c.env.DB.prepare(
    `DELETE FROM helpful_votes
      WHERE user_email = ? AND target_type = 'comment' AND target_id = ?`
  )
    .bind(c.var.email, cid)
    .run();

  return c.json({
    ok: true,
    helpful_count: await helpfulCount(c.env.DB, cid),
    voted_by_me: false,
  });
});

async function helpfulCount(db: D1Database, cid: string): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM helpful_votes
        WHERE target_type = 'comment' AND target_id = ?`
    )
    .bind(cid)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

// 每則留言一生只通知一次,且不揭露投票人(actor_email = NULL),避免在
// 20 人熟人圈變成人情債。notifications 自身即「是否通知過」的事實來源,
// 不需要多一張表。
async function maybeNotifyFirstHelpful(
  db: D1Database,
  args: {
    cid: string;
    target: { author_email: string; question_id: string };
    now: number;
  }
): Promise<void> {
  const seen = await db
    .prepare(
      `SELECT 1 FROM notifications WHERE kind = 'helpful' AND comment_id = ? LIMIT 1`
    )
    .bind(args.cid)
    .first();
  if (seen) return;

  await db
    .prepare(
      `INSERT INTO notifications
         (id, recipient, kind, question_id, comment_id, actor_email, preview, created_at)
       VALUES (?, ?, 'helpful', ?, ?, NULL, ?, ?)`
    )
    .bind(
      uuid(),
      args.target.author_email,
      args.target.question_id,
      args.cid,
      '有人覺得你的留言有幫助',
      args.now
    )
    .run();
}

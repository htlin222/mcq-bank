import { Hono } from 'hono';
import type { AppContext } from '../types';

export const reviewRoutes = new Hono<AppContext>();

// Record an answer in review mode (also increments times_seen)
reviewRoutes.post('/answer', async (c) => {
  const email = c.var.email;
  const body = await c.req.json<{ question_id: string; chosen: string }>();
  const now = Date.now();

  // Check correctness
  const q = await c.env.DB
    .prepare('SELECT answer FROM questions WHERE id = ?')
    .bind(body.question_id)
    .first<{ answer: string }>();

  if (!q) return c.json({ error: 'no such question' }, 404);
  const isCorrect = q.answer === body.chosen ? 1 : 0;

  await c.env.DB
    .prepare(
      `INSERT INTO review_progress
       (user_email, question_id, times_seen, times_correct, last_seen_at, last_chosen, last_correct)
       VALUES (?, ?, 1, ?, ?, ?, ?)
       ON CONFLICT(user_email, question_id) DO UPDATE SET
         times_seen = times_seen + 1,
         times_correct = times_correct + ?,
         last_seen_at = ?,
         last_chosen = ?,
         last_correct = ?`
    )
    .bind(
      email, body.question_id, isCorrect, now, body.chosen, isCorrect,
      isCorrect, now, body.chosen, isCorrect
    )
    .run();

  return c.json({ correct: !!isCorrect, correct_answer: q.answer });
});

// Clear this user's review_progress for one question — used by the
// "清除本題作答紀錄" action in the reveal row. Idempotent.
reviewRoutes.delete('/answer/:id', async (c) => {
  const email = c.var.email;
  const id = c.req.param('id');
  await c.env.DB
    .prepare('DELETE FROM review_progress WHERE user_email = ? AND question_id = ?')
    .bind(email, id)
    .run();
  return c.json({ ok: true });
});

// Daily activity heatmap (for cal-heatmap). Counts answered questions
// (review-mode + exam-mode) per local-day for the last N days.
reviewRoutes.get('/heatmap', async (c) => {
  const email = c.var.email;
  const days = Math.min(parseInt(c.req.query('days') || '120'), 365);
  const since = Date.now() - days * 86_400_000;

  // Buckets: bind everything to the user's clock by computing day-strings
  // (YYYY-MM-DD) in UTC+8 (Asia/Taipei). D1 supports strftime modifier '+8 hours'.
  const { results } = await c.env.DB
    .prepare(
      `WITH a AS (
         SELECT last_seen_at AS ts FROM review_progress
           WHERE user_email = ? AND last_seen_at >= ?
         UNION ALL
         SELECT ea.answered_at FROM exam_answers ea
           JOIN exam_sessions es ON es.id = ea.session_id
           WHERE es.user_email = ? AND ea.answered_at >= ?
       )
       SELECT strftime('%Y-%m-%d', ts / 1000, 'unixepoch', '+8 hours') AS d,
              COUNT(*) AS n
       FROM a
       WHERE ts IS NOT NULL
       GROUP BY d
       ORDER BY d`
    )
    .bind(email, since, email, since)
    .all<{ d: string; n: number }>();
  return c.json(results);
});

// My stats
reviewRoutes.get('/stats', async (c) => {
  const email = c.var.email;

  const totalSeen = await c.env.DB
    .prepare(
      'SELECT COUNT(*) as n FROM review_progress WHERE user_email = ? AND times_seen > 0'
    )
    .bind(email)
    .first<{ n: number }>();

  const totalCorrect = await c.env.DB
    .prepare(
      'SELECT SUM(times_correct) as c, SUM(times_seen) as t FROM review_progress WHERE user_email = ?'
    )
    .bind(email)
    .first<{ c: number; t: number }>();

  const byYear = await c.env.DB
    .prepare(
      `SELECT q.year, COUNT(*) as seen, SUM(rp.last_correct) as correct
       FROM review_progress rp
       JOIN questions q ON q.id = rp.question_id
       WHERE rp.user_email = ?
       GROUP BY q.year
       ORDER BY q.year DESC`
    )
    .bind(email)
    .all();

  return c.json({
    questions_attempted: totalSeen?.n ?? 0,
    total_correct: totalCorrect?.c ?? 0,
    total_attempts: totalCorrect?.t ?? 0,
    by_year: byYear.results,
  });
});

// Wrong-answer list (review-mode mistakes), with year/tag/group filters
reviewRoutes.get('/wrong', async (c) => {
  const email = c.var.email;
  const year = c.req.query('year');
  const group = c.req.query('group');
  const tags = c.req.query('tags');

  const where: string[] = [
    'rp.user_email = ?',
    'rp.times_seen > 0',
    '(rp.times_correct * 100 / rp.times_seen) < 100',
  ];
  const params: any[] = [email];

  if (year) { where.push('q.year = ?'); params.push(parseInt(year)); }
  if (group) { where.push('q."group" = ?'); params.push(group); }

  let tagJoin = '';
  if (tags) {
    const list = tags.split(',').map((t) => t.trim()).filter(Boolean);
    if (list.length > 0) {
      tagJoin = `
        JOIN (
          SELECT question_id FROM question_tags
          WHERE tag IN (${list.map(() => '?').join(',')})
          GROUP BY question_id
          HAVING COUNT(DISTINCT tag) = ?
        ) tf ON tf.question_id = q.id
      `;
      params.push(...list, list.length);
    }
  }

  const sql = `
    SELECT q.id, q.year, q.number, q.stem, q."group",
           rp.times_seen, rp.times_correct
    FROM review_progress rp
    JOIN questions q ON q.id = rp.question_id
    ${tagJoin}
    WHERE ${where.join(' AND ')}
    ORDER BY (rp.times_correct * 100 / rp.times_seen) ASC, rp.last_seen_at DESC
    LIMIT 200
  `;
  const { results } = await c.env.DB.prepare(sql).bind(...params).all();
  return c.json(results);
});

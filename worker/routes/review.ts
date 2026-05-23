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

// Toggle bookmark
reviewRoutes.post('/bookmark', async (c) => {
  const email = c.var.email;
  const body = await c.req.json<{ question_id: string; bookmarked: boolean }>();

  await c.env.DB
    .prepare(
      `INSERT INTO review_progress (user_email, question_id, bookmarked, last_seen_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_email, question_id) DO UPDATE SET bookmarked = ?`
    )
    .bind(email, body.question_id, body.bookmarked ? 1 : 0, Date.now(), body.bookmarked ? 1 : 0)
    .run();

  return c.json({ ok: true });
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

// Bookmarked questions
reviewRoutes.get('/bookmarks', async (c) => {
  const email = c.var.email;
  const { results } = await c.env.DB
    .prepare(
      `SELECT q.id, q.year, q.number, q.stem, q."group"
       FROM review_progress rp
       JOIN questions q ON q.id = rp.question_id
       WHERE rp.user_email = ? AND rp.bookmarked = 1
       ORDER BY q.year DESC, q.number ASC`
    )
    .bind(email)
    .all();
  return c.json(results);
});

// Wrong-answer list (review-mode mistakes)
reviewRoutes.get('/wrong', async (c) => {
  const email = c.var.email;
  const { results } = await c.env.DB
    .prepare(
      `SELECT q.id, q.year, q.number, q.stem, q."group",
              rp.times_seen, rp.times_correct
       FROM review_progress rp
       JOIN questions q ON q.id = rp.question_id
       WHERE rp.user_email = ?
         AND rp.times_seen > 0
         AND (rp.times_correct * 100 / rp.times_seen) < 100
       ORDER BY (rp.times_correct * 100 / rp.times_seen) ASC, rp.last_seen_at DESC
       LIMIT 100`
    )
    .bind(email)
    .all();
  return c.json(results);
});

import { Hono } from 'hono';
import type { AppContext, ExamSession, Question } from '../types';
import { uuid } from '../lib/db';

export const examRoutes = new Hono<AppContext>();

// Start a new exam session for a given year (100 questions)
examRoutes.post('/start', async (c) => {
  const email = c.var.email;
  const body = await c.req.json<{ year: number; mode?: 'full' | 'partial' }>();

  const { results: questions } = await c.env.DB
    .prepare(
      `SELECT id, year, number, stem, options_json
       FROM questions WHERE year = ? ORDER BY number ASC`
    )
    .bind(body.year)
    .all<Pick<Question, 'id' | 'year' | 'number' | 'stem' | 'options_json'>>();

  if (questions.length === 0) {
    return c.json({ error: 'no questions for that year' }, 404);
  }

  const sessionId = uuid();
  const now = Date.now();

  // Create session + empty answer rows in one batch
  const ops = [
    c.env.DB
      .prepare(
        `INSERT INTO exam_sessions (id, user_email, year, started_at, mode)
         VALUES (?, ?, ?, ?, ?)`
      )
      .bind(sessionId, email, body.year, now, body.mode || 'full'),
  ];
  for (const q of questions) {
    ops.push(
      c.env.DB
        .prepare(
          `INSERT INTO exam_answers (session_id, question_id) VALUES (?, ?)`
        )
        .bind(sessionId, q.id)
    );
  }
  await c.env.DB.batch(ops);

  return c.json({
    session_id: sessionId,
    started_at: now,
    questions: questions.map((q) => ({
      id: q.id,
      number: q.number,
      stem: q.stem,
      options: JSON.parse(q.options_json),
    })),
  });
});

// Submit an answer (can be called multiple times to update)
examRoutes.post('/:sid/answer', async (c) => {
  const sid = c.req.param('sid');
  const email = c.var.email;
  const body = await c.req.json<{ question_id: string; chosen: string }>();

  // Ownership + active session check
  const session = await c.env.DB
    .prepare(
      'SELECT user_email, finished_at FROM exam_sessions WHERE id = ?'
    )
    .bind(sid)
    .first<{ user_email: string; finished_at: number | null }>();

  if (!session) return c.json({ error: 'session not found' }, 404);
  if (session.user_email !== email) return c.json({ error: 'forbidden' }, 403);
  if (session.finished_at) return c.json({ error: 'session already finished' }, 400);

  await c.env.DB
    .prepare(
      `UPDATE exam_answers
       SET chosen = ?, answered_at = ?
       WHERE session_id = ? AND question_id = ?`
    )
    .bind(body.chosen, Date.now(), sid, body.question_id)
    .run();

  return c.json({ ok: true });
});

// Finish the exam — computes score
examRoutes.post('/:sid/finish', async (c) => {
  const sid = c.req.param('sid');
  const email = c.var.email;
  const now = Date.now();

  const session = await c.env.DB
    .prepare(
      'SELECT * FROM exam_sessions WHERE id = ?'
    )
    .bind(sid)
    .first<ExamSession>();

  if (!session) return c.json({ error: 'session not found' }, 404);
  if (session.user_email !== email) return c.json({ error: 'forbidden' }, 403);
  if (session.finished_at) return c.json({ error: 'already finished' }, 400);

  // Compute correctness
  await c.env.DB
    .prepare(
      `UPDATE exam_answers
       SET is_correct = CASE
         WHEN chosen = (SELECT answer FROM questions WHERE id = exam_answers.question_id)
         THEN 1 ELSE 0 END
       WHERE session_id = ?`
    )
    .bind(sid)
    .run();

  const correct = await c.env.DB
    .prepare(
      `SELECT COUNT(*) as n FROM exam_answers WHERE session_id = ? AND is_correct = 1`
    )
    .bind(sid)
    .first<{ n: number }>();

  const duration = Math.floor((now - session.started_at) / 1000);

  await c.env.DB
    .prepare(
      `UPDATE exam_sessions
       SET finished_at = ?, score = ?, duration_sec = ?
       WHERE id = ?`
    )
    .bind(now, correct!.n, duration, sid)
    .run();

  return c.json({ score: correct!.n, duration_sec: duration });
});

// Get session results
examRoutes.get('/:sid', async (c) => {
  const sid = c.req.param('sid');
  const email = c.var.email;

  const session = await c.env.DB
    .prepare('SELECT * FROM exam_sessions WHERE id = ?')
    .bind(sid)
    .first<ExamSession>();

  if (!session) return c.json({ error: 'not found' }, 404);
  if (session.user_email !== email) return c.json({ error: 'forbidden' }, 403);

  const { results: answers } = await c.env.DB
    .prepare(
      `SELECT ea.question_id, ea.chosen, ea.is_correct, ea.answered_at,
              q.number, q.answer as correct_answer, q.stem
       FROM exam_answers ea
       JOIN questions q ON q.id = ea.question_id
       WHERE ea.session_id = ?
       ORDER BY q.number ASC`
    )
    .bind(sid)
    .all();

  return c.json({ session, answers });
});

// My exam history
examRoutes.get('/', async (c) => {
  const email = c.var.email;
  const { results } = await c.env.DB
    .prepare(
      `SELECT * FROM exam_sessions
       WHERE user_email = ?
       ORDER BY started_at DESC
       LIMIT 50`
    )
    .bind(email)
    .all();
  return c.json(results);
});

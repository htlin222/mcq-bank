import { Hono } from 'hono';
import type { AppContext, ExamSession, Question } from '../types';
import { uuid, optionsToRecord } from '../lib/db';

export const examRoutes = new Hono<AppContext>();

// Real exam pacing: 1 minute per question. 100 questions → 100 min,
// 內科 only (70) → 70 min, 共同 only (30) → 30 min.
const MS_PER_QUESTION = 60 * 1000;
const VALID_GROUPS = ['內科', '共同'] as const;
type Group = (typeof VALID_GROUPS)[number];

// Start a new exam session. `groups` defaults to both 內科 + 共同 for
// backwards compatibility with older clients that don't send it.
examRoutes.post('/start', async (c) => {
  const email = c.var.email;
  const body = await c.req.json<{
    year: number;
    mode?: 'full' | 'partial';
    groups?: Group[];
  }>();

  const groups: Group[] = Array.isArray(body.groups) && body.groups.length > 0
    ? body.groups.filter((g): g is Group => VALID_GROUPS.includes(g))
    : [...VALID_GROUPS];
  if (groups.length === 0) {
    return c.json({ error: 'invalid groups' }, 400);
  }
  const placeholders = groups.map(() => '?').join(',');

  const { results: questions } = await c.env.DB
    .prepare(
      `SELECT id, year, number, stem, options_json
       FROM questions WHERE year = ? AND "group" IN (${placeholders})
       ORDER BY number ASC`
    )
    .bind(body.year, ...groups)
    .all<Pick<Question, 'id' | 'year' | 'number' | 'stem' | 'options_json'>>();

  if (questions.length === 0) {
    return c.json({ error: 'no questions for that selection' }, 404);
  }

  const sessionId = uuid();
  const now = Date.now();
  const capMs = questions.length * MS_PER_QUESTION;

  // Create session (immediately running) + empty answer rows in one batch
  const ops = [
    c.env.DB
      .prepare(
        `INSERT INTO exam_sessions (id, user_email, year, started_at, mode, elapsed_ms, running_since, cap_ms)
         VALUES (?, ?, ?, ?, ?, 0, ?, ?)`
      )
      .bind(sessionId, email, body.year, now, body.mode || 'full', now, capMs),
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
    elapsed_ms: 0,
    running_since: now,
    cap_ms: capMs,
    questions: questions.map((q) => ({
      id: q.id,
      number: q.number,
      stem: q.stem,
      options: optionsToRecord(q.options_json),
    })),
  });
});

// Resume / fetch an in-progress session (with all questions + saved answers).
// Used when the user navigates back to /exam/:sid after leaving.
examRoutes.get('/:sid/state', async (c) => {
  const sid = c.req.param('sid');
  const email = c.var.email;
  const now = Date.now();

  const session = await c.env.DB
    .prepare('SELECT * FROM exam_sessions WHERE id = ?')
    .bind(sid)
    .first<ExamSession & { elapsed_ms: number; running_since: number | null; cap_ms: number }>();
  if (!session) return c.json({ error: 'not found' }, 404);
  if (session.user_email !== email) return c.json({ error: 'forbidden' }, 403);
  if (session.finished_at) return c.json({ error: 'already finished' }, 410);

  const { results: rows } = await c.env.DB
    .prepare(
      `SELECT q.id, q.number, q.stem, q.options_json, ea.chosen
       FROM exam_answers ea
       JOIN questions q ON q.id = ea.question_id
       WHERE ea.session_id = ?
       ORDER BY q.number ASC`
    )
    .bind(sid)
    .all<{ id: string; number: number; stem: string; options_json: string; chosen: string | null }>();

  const liveElapsed = session.running_since
    ? session.elapsed_ms + (now - session.running_since)
    : session.elapsed_ms;

  return c.json({
    session_id: sid,
    started_at: session.started_at,
    elapsed_ms: liveElapsed,
    running_since: session.running_since,
    cap_ms: session.cap_ms,
    questions: rows.map((r) => ({
      id: r.id,
      number: r.number,
      stem: r.stem,
      options: optionsToRecord(r.options_json),
      chosen: r.chosen,
    })),
  });
});

// Pause — freeze the timer
examRoutes.post('/:sid/pause', async (c) => {
  const sid = c.req.param('sid');
  const email = c.var.email;
  const now = Date.now();

  const s = await c.env.DB
    .prepare(
      'SELECT user_email, finished_at, elapsed_ms, running_since FROM exam_sessions WHERE id = ?'
    )
    .bind(sid)
    .first<{ user_email: string; finished_at: number | null; elapsed_ms: number; running_since: number | null }>();
  if (!s) return c.json({ error: 'not found' }, 404);
  if (s.user_email !== email) return c.json({ error: 'forbidden' }, 403);
  if (s.finished_at) return c.json({ error: 'already finished' }, 400);
  if (s.running_since === null) {
    return c.json({ ok: true, elapsed_ms: s.elapsed_ms, running_since: null, already: true });
  }

  const newElapsed = s.elapsed_ms + (now - s.running_since);
  await c.env.DB
    .prepare(
      'UPDATE exam_sessions SET elapsed_ms = ?, running_since = NULL WHERE id = ?'
    )
    .bind(newElapsed, sid)
    .run();

  return c.json({ ok: true, elapsed_ms: newElapsed, running_since: null });
});

// Resume — un-freeze
examRoutes.post('/:sid/resume', async (c) => {
  const sid = c.req.param('sid');
  const email = c.var.email;
  const now = Date.now();

  const s = await c.env.DB
    .prepare(
      'SELECT user_email, finished_at, elapsed_ms, running_since, cap_ms FROM exam_sessions WHERE id = ?'
    )
    .bind(sid)
    .first<{ user_email: string; finished_at: number | null; elapsed_ms: number; running_since: number | null; cap_ms: number }>();
  if (!s) return c.json({ error: 'not found' }, 404);
  if (s.user_email !== email) return c.json({ error: 'forbidden' }, 403);
  if (s.finished_at) return c.json({ error: 'already finished' }, 400);
  if (s.running_since !== null) {
    return c.json({ ok: true, elapsed_ms: s.elapsed_ms, running_since: s.running_since, already: true });
  }
  // Refuse resume if already past cap — force-finish instead
  if (s.elapsed_ms >= s.cap_ms) {
    return c.json({ error: 'time cap reached, must finish', elapsed_ms: s.elapsed_ms, cap_ms: s.cap_ms }, 409);
  }

  await c.env.DB
    .prepare(
      'UPDATE exam_sessions SET running_since = ? WHERE id = ?'
    )
    .bind(now, sid)
    .run();
  return c.json({ ok: true, elapsed_ms: s.elapsed_ms, running_since: now });
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

// Finish the exam — computes score, freezes timer
examRoutes.post('/:sid/finish', async (c) => {
  const sid = c.req.param('sid');
  const email = c.var.email;
  const now = Date.now();

  const session = await c.env.DB
    .prepare(
      'SELECT * FROM exam_sessions WHERE id = ?'
    )
    .bind(sid)
    .first<ExamSession & { elapsed_ms: number; running_since: number | null; cap_ms: number }>();

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

  // Finalize elapsed time — clamp to the session's cap so abandoned
  // sessions resumed past the cap don't get an unbounded duration.
  const liveElapsed = session.running_since
    ? session.elapsed_ms + (now - session.running_since)
    : session.elapsed_ms;
  const finalMs = Math.min(liveElapsed, session.cap_ms);
  const duration = Math.floor(finalMs / 1000);

  await c.env.DB
    .prepare(
      `UPDATE exam_sessions
       SET finished_at = ?, score = ?, duration_sec = ?,
           elapsed_ms = ?, running_since = NULL
       WHERE id = ?`
    )
    .bind(now, correct!.n, duration, finalMs, sid)
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

// Delete one of my sessions (works for in-progress or finished).
// exam_answers cascades via ON DELETE CASCADE.
examRoutes.delete('/:sid', async (c) => {
  const sid = c.req.param('sid');
  const email = c.var.email;
  const owner = await c.env.DB
    .prepare('SELECT user_email FROM exam_sessions WHERE id = ?')
    .bind(sid)
    .first<{ user_email: string }>();
  if (!owner) return c.json({ error: 'not found' }, 404);
  if (owner.user_email !== email) return c.json({ error: 'forbidden' }, 403);
  await c.env.DB
    .prepare('DELETE FROM exam_sessions WHERE id = ?')
    .bind(sid)
    .run();
  return c.json({ ok: true });
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

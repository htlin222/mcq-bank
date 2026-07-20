import { Hono } from 'hono';
import type { AppContext, Env, ExamSession, Question } from '../types';
import { uuid, optionsToRecord } from '../lib/db';
import { clampElapsedMs, insertAttemptOp } from '../lib/attempts';
import { median, pacingSplit } from '../lib/pacing';
import { buildTestFilter, normalizeFilters, type RawTestFilters } from '../lib/testBuilder';

export const examRoutes = new Hono<AppContext>();

// Real exam pacing: 1 minute per question. Total cap derives from the
// group composition declared in config.toml [groups].list — see the
// GROUPS env var. e.g. "內科:70,共同:30" → 100 min cap when both selected.
const MS_PER_QUESTION = 60 * 1000;

// Cached per request — parsed lazily so a hot reload of GROUPS picks up.
function parseGroupsConfig(raw: string | undefined): Array<{ label: string; count: number }> {
  if (!raw) return [];
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const sep = part.lastIndexOf(':');
      if (sep < 0) return { label: part, count: 0 };
      return {
        label: part.slice(0, sep).trim(),
        count: Number(part.slice(sep + 1).trim()) || 0,
      };
    });
}

function validGroupLabels(env: Env): string[] {
  // No fallback — if GROUPS is unset, the worker returns 400 from /start so
  // the operator gets a clear signal that wrangler.toml needs the var.
  return parseGroupsConfig(env.GROUPS).map((g) => g.label);
}

// Start a new exam session. `groups` defaults to the full configured set
// for backwards compatibility with older clients that don't send it.
examRoutes.post('/start', async (c) => {
  const email = c.var.email;
  const body = await c.req.json<{
    year: number;
    mode?: 'full' | 'partial';
    groups?: string[];
  }>();

  const validGroups = validGroupLabels(c.env);
  const groups: string[] = Array.isArray(body.groups) && body.groups.length > 0
    ? body.groups.filter((g) => validGroups.includes(g))
    : [...validGroups];
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

// ---------------------------------------------------------------------------
// 自訂測驗(custom test builder)
//
// 產生的 session 與 /start 完全同構:一列 exam_sessions + N 列 exam_answers,
// 下游的 /state /answer /pause /resume /finish /:sid 一行都不用改(除了排序
// 改吃 ea.seq)。差別只在 exam_sessions.kind='custom'、year=0 哨兵,以及
// tutor/timed/filter_json 三個旗標。
//
// 這兩個 handler 必須註冊在 /:sid/* 之前 —— Hono 依註冊順序比對,
// POST /custom/preview 與 POST /:sid/pause 同為兩段路徑。
// ---------------------------------------------------------------------------

// 不計時:cap 大到不會觸發自動交卷(前端改為往上計時的碼表)。
const UNTIMED_CAP_MS = 24 * 60 * 60 * 1000;

// 預覽符合題數 — UI 每次改條件就打一次,只做一個 COUNT(*),不建 session。
examRoutes.post('/custom/preview', async (c) => {
  const email = c.var.email;
  const f = normalizeFilters(await c.req.json<RawTestFilters>().catch(() => ({})));
  const { joinSql, whereSql, params } = buildTestFilter(f, email);

  const row = await c.env.DB
    .prepare(`SELECT COUNT(*) AS n FROM questions q ${joinSql} ${whereSql}`)
    .bind(...params)
    .first<{ n: number }>();

  const available = row?.n ?? 0;
  return c.json({ available, requested: f.count, will_use: Math.min(available, f.count) });
});

// 依篩選條件抽題並建立一場自訂測驗。回傳體與 /start 同形(多帶 kind/tutor/
// timed/year 與 requested/actual),前端可共用型別。
examRoutes.post('/custom', async (c) => {
  const email = c.var.email;
  const f = normalizeFilters(await c.req.json<RawTestFilters>().catch(() => ({})));
  const { joinSql, whereSql, params } = buildTestFilter(f, email);

  // 隨機抽題:D1 的 RANDOM() 對 1000 列題庫成本可忽略。
  const { results: questions } = await c.env.DB
    .prepare(
      `SELECT q.id, q.year, q.number, q.stem, q.options_json
       FROM questions q ${joinSql} ${whereSql}
       ORDER BY RANDOM() LIMIT ?`
    )
    .bind(...params, f.count)
    .all<Pick<Question, 'id' | 'year' | 'number' | 'stem' | 'options_json'>>();

  if (questions.length === 0) {
    return c.json({ error: 'no questions match', available: 0 }, 404);
  }

  const sessionId = uuid();
  const now = Date.now();
  // 題數不足時不報錯 —— 直接用實際可用題數出卷,回傳體帶 requested/actual
  // 讓 UI 講清楚(不靜默截斷)。
  const capMs = f.timed ? questions.length * MS_PER_QUESTION : UNTIMED_CAP_MS;

  const ops = [
    c.env.DB
      .prepare(
        `INSERT INTO exam_sessions
           (id, user_email, year, started_at, mode, elapsed_ms, running_since, cap_ms,
            kind, tutor, timed, filter_json)
         VALUES (?, ?, 0, ?, 'partial', 0, ?, ?, 'custom', ?, ?, ?)`
      )
      .bind(
        sessionId,
        email,
        now,
        now,
        capMs,
        f.tutor ? 1 : 0,
        f.timed ? 1 : 0,
        JSON.stringify(f),
      ),
  ];
  questions.forEach((q, i) => {
    ops.push(
      c.env.DB
        .prepare(`INSERT INTO exam_answers (session_id, question_id, seq) VALUES (?, ?, ?)`)
        .bind(sessionId, q.id, i)
    );
  });
  await c.env.DB.batch(ops);

  return c.json({
    session_id: sessionId,
    started_at: now,
    elapsed_ms: 0,
    running_since: now,
    cap_ms: capMs,
    kind: 'custom' as const,
    tutor: (f.tutor ? 1 : 0) as 0 | 1,
    timed: (f.timed ? 1 : 0) as 0 | 1,
    requested: f.count,
    actual: questions.length,
    questions: questions.map((q) => ({
      id: q.id,
      year: q.year,
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
      // COALESCE(ea.seq, q.number):自訂測驗跨年份時 q.number 會重複,seq 才是
      // 卷內順序;seq 為 NULL 的舊 session 退回原本的 q.number 排序(等價)。
      `SELECT q.id, q.year, q.number, q.stem, q.options_json, ea.chosen
       FROM exam_answers ea
       JOIN questions q ON q.id = ea.question_id
       WHERE ea.session_id = ?
       ORDER BY COALESCE(ea.seq, q.number) ASC, q.year ASC, q.number ASC`
    )
    .bind(sid)
    .all<{ id: string; year: number; number: number; stem: string; options_json: string; chosen: string | null }>();

  const liveElapsed = session.running_since
    ? session.elapsed_ms + (now - session.running_since)
    : session.elapsed_ms;

  return c.json({
    session_id: sid,
    started_at: session.started_at,
    elapsed_ms: liveElapsed,
    running_since: session.running_since,
    cap_ms: session.cap_ms,
    // 自訂測驗的 UI 靠這三個旗標決定計時方向、標題與 tutor 揭曉。
    // 舊 session 由 migration 0026 的 DEFAULT 落在 'year'/0/1。
    kind: session.kind,
    tutor: session.tutor,
    timed: session.timed,
    questions: rows.map((r) => ({
      id: r.id,
      year: r.year,
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
  const body = await c.req.json<{
    question_id: string;
    chosen: string;
    elapsed_ms?: number;
  }>();

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

  // exam_answers 仍是 resume 用的「當前作答狀態」(可覆寫);attempts 則
  // append 一筆事件。改答案會產生多筆 attempt — 這是刻意的,改答案本身
  // 就是配速訊號,配速報告以 SUM(elapsed_ms) 聚合同一 (session, question)。
  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB
      .prepare(
        `UPDATE exam_answers
         SET chosen = ?, answered_at = ?
         WHERE session_id = ? AND question_id = ?`
      )
      .bind(body.chosen, now, sid, body.question_id),
    insertAttemptOp({
      db: c.env.DB,
      email,
      questionId: body.question_id,
      chosen: body.chosen,
      isCorrect: null, // 模擬考交卷前不揭曉,判定留給 finish
      source: 'exam',
      sessionId: sid,
      elapsedMs: clampElapsedMs(body.elapsed_ms),
      now,
    }),
  ]);

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

  // Compute correctness AND snapshot the canonical answer at finish time so
  // a later challenge promotion doesn't retroactively rescore this attempt.
  await c.env.DB
    .prepare(
      `UPDATE exam_answers
       SET correct_answer_at_finish = (SELECT answer FROM questions WHERE id = exam_answers.question_id),
           is_correct = CASE
             WHEN chosen = (SELECT answer FROM questions WHERE id = exam_answers.question_id)
             THEN 1 ELSE 0 END
       WHERE session_id = ?`
    )
    .bind(sid)
    .run();

  // Backfill the attempt log's verdict now that the answer is revealed.
  // Uses the same correct_answer_at_finish snapshot so a later challenge
  // promotion doesn't retroactively rewrite this session's history.
  await c.env.DB
    .prepare(
      `UPDATE attempts
       SET is_correct = CASE
             WHEN chosen = (SELECT COALESCE(ea.correct_answer_at_finish, q.answer)
                            FROM exam_answers ea JOIN questions q ON q.id = ea.question_id
                            WHERE ea.session_id = attempts.session_id
                              AND ea.question_id = attempts.question_id)
             THEN 1 ELSE 0 END
       WHERE session_id = ? AND is_correct IS NULL`
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

  // SUM (not MAX) over attempts: changing an answer appends another attempt,
  // and the total is what the question actually cost. Sessions predating
  // migration 0023 have no attempts → NULL → the UI shows "—".
  const { results: answers } = await c.env.DB
    .prepare(
      `SELECT ea.question_id, ea.chosen, ea.is_correct, ea.answered_at,
              q.year, q.number, q.stem,
              COALESCE(ea.correct_answer_at_finish, q.answer) AS correct_answer,
              t.elapsed_ms
       FROM exam_answers ea
       JOIN questions q ON q.id = ea.question_id
       LEFT JOIN (
         SELECT question_id, SUM(elapsed_ms) AS elapsed_ms
         FROM attempts WHERE session_id = ? AND elapsed_ms IS NOT NULL
         GROUP BY question_id
       ) t ON t.question_id = ea.question_id
       WHERE ea.session_id = ?
       ORDER BY COALESCE(ea.seq, q.number) ASC, q.year ASC, q.number ASC`
    )
    .bind(sid, sid)
    .all();

  return c.json({ session, answers });
});

// Pacing report for one finished session — first-half vs second-half
// average time, plus the slowest questions. Sessions with no timing data
// (pre-0023) return n: 0 rather than erroring.
examRoutes.get('/:sid/pacing', async (c) => {
  const sid = c.req.param('sid');
  const email = c.var.email;

  const session = await c.env.DB
    .prepare('SELECT user_email FROM exam_sessions WHERE id = ?')
    .bind(sid)
    .first<{ user_email: string }>();

  if (!session) return c.json({ error: 'not found' }, 404);
  if (session.user_email !== email) return c.json({ error: 'forbidden' }, 403);

  // ORDER BY first-touch time = answering order, NOT question number.
  const { results: rows } = await c.env.DB
    .prepare(
      `SELECT a.question_id, q.number, SUM(a.elapsed_ms) AS ms
       FROM attempts a
       JOIN questions q ON q.id = a.question_id
       WHERE a.session_id = ? AND a.elapsed_ms IS NOT NULL
       GROUP BY a.question_id
       ORDER BY MIN(a.created_at)`
    )
    .bind(sid)
    .all<{ question_id: string; number: number; ms: number }>();

  const times = rows.map((r) => r.ms);
  const split = pacingSplit(times);
  const slowest = [...rows]
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 5)
    .map((r) => ({ question_id: r.question_id, number: r.number, ms: r.ms }));

  return c.json({
    n: times.length,
    first_half_avg_ms: split ? Math.round(split.firstHalfAvg) : null,
    second_half_avg_ms: split ? Math.round(split.secondHalfAvg) : null,
    delta_pct: split ? split.deltaPct : null,
    median_ms: median(times),
    slowest,
  });
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

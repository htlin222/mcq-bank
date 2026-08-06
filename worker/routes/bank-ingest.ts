import { Hono } from 'hono';
import type { AppContext } from '../types';
import { bankKeyMiddleware } from '../lib/bank-key';
import { isAdminEmail } from '../lib/admin';
import {
  assertPublishable,
  buildGroupComposition,
  makeQuestionId,
  needsReview,
  validateStaged,
  type StagedQuestion,
} from '../lib/import-validate';

/**
 * 新年份題庫匯入 — 設計文件 docs/plans/2026-08-06-new-year-ingest-design.md
 *
 * Two route groups with deliberately different auth, exported separately
 * because they must be mounted on opposite sides of the Access middleware:
 *
 *   bankIngestRoutes  /api/bank-ingest/*      bnkk_ key. Mounted BEFORE
 *                                             authMiddleware and Access-
 *                                             bypassed at the edge, because
 *                                             the caller is a python script
 *                                             on a laptop with no Access
 *                                             session. Can ONLY write the
 *                                             staging area.
 *
 *   bankAdminRoutes   /api/admin/import-year/* Access session + ADMIN_EMAILS.
 *                                             The only path that can promote
 *                                             staged rows into `questions`.
 *
 * That split is the whole security story: a stolen laptop yields a key that
 * can stage garbage nobody can see, and nothing else.
 */

const STAGES = [
  'ready',
  'parsing',
  'parsed',
  'explaining',
  'pushed',
  'published',
] as const;
type Stage = (typeof STAGES)[number];

/** Stages the skill is allowed to set. It can't publish or discard. */
const SKILL_STAGES: Stage[] = ['ready', 'parsing', 'parsed', 'explaining', 'pushed'];

type JobRow = {
  id: string;
  year: number;
  created_by: string;
  stage: Stage;
  detail: string | null;
  question_count: number;
  needs_review: number;
  created_at: number;
  updated_at: number;
};

// 民國年. Upper bound is generous rather than tied to "today" — the Worker has
// no business deciding which exam years exist, and a wrong clock shouldn't
// block an import.
const YEAR_MIN = 90;
const YEAR_MAX = 200;

function parseYear(raw: unknown): number | null {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isInteger(n) || n < YEAR_MIN || n > YEAR_MAX) return null;
  return n;
}

async function loadJob(
  c: { env: { DB: D1Database } },
  id: string,
): Promise<JobRow | null> {
  return await c.env.DB.prepare('SELECT * FROM import_jobs WHERE id = ?')
    .bind(id)
    .first<JobRow>();
}

/** Recount question_count / needs_review from what's actually staged. */
async function recount(db: D1Database, jobId: string): Promise<{ total: number; review: number }> {
  const { results } = await db
    .prepare('SELECT payload FROM import_staging WHERE job_id = ?')
    .bind(jobId)
    .all<{ payload: string }>();
  let review = 0;
  for (const r of results ?? []) {
    try {
      if (needsReview(JSON.parse(r.payload) as StagedQuestion)) review++;
    } catch {
      review++; // unparseable payload is definitionally something to look at
    }
  }
  return { total: results?.length ?? 0, review };
}

// ===========================================================================
// Group 1 — the skill's write surface (bnkk_ key)
// ===========================================================================

export const bankIngestRoutes = new Hono<AppContext>();

bankIngestRoutes.use('*', bankKeyMiddleware);

/**
 * POST /api/bank-ingest/heartbeat
 *
 * Called by doctor.py after `uv sync`, and again whenever the skill starts.
 * Deliberately does almost nothing: its value is that reaching a 200 here
 * proves the key is valid, the email is on the admin list, and the network
 * path works. Without it, a key that was rotated after download only fails at
 * push time — after the operator has already sat through a full PDF parse.
 */
bankIngestRoutes.post('/heartbeat', async (c) => {
  const email = c.var.email;
  const now = Date.now();
  await c.env.DB.prepare(
    'UPDATE users SET bank_last_seen_at = ?, updated_at = ? WHERE email = ?',
  )
    .bind(now, now, email)
    .run();
  return c.json({ ok: true, email, at: now });
});

/**
 * GET /api/bank-ingest/config
 *
 * The skill needs the group composition ("內科:70,共同:30") to map each PDF's
 * local 1..N numbering onto the bank's global numbering. Serving it here keeps
 * config.toml the single source of truth — hard-coding it in the skill would
 * silently break any fork with a different exam shape.
 */
bankIngestRoutes.get('/config', (c) => {
  const comp = buildGroupComposition(c.env.GROUPS);
  return c.json({
    groups: comp.groups.map((g) => ({
      label: g.label,
      count: g.count,
      start_number: g.startNumber,
      end_number: g.endNumber,
    })),
    total: comp.total,
  });
});

/**
 * POST /api/bank-ingest/jobs  { year }
 *
 * Idempotent: re-running the skill for a year that already has a live job
 * returns that job rather than colliding with the partial-unique index. The
 * skill then overwrites its own staged rows, which is what a re-run means.
 */
bankIngestRoutes.post('/jobs', async (c) => {
  const body = await c.req.json<{ year?: unknown }>().catch(() => ({}) as Record<string, unknown>);
  const year = parseYear(body.year);
  if (year === null) return c.json({ error: `year must be an integer ${YEAR_MIN}-${YEAR_MAX}` }, 400);

  const existing = await c.env.DB.prepare(
    `SELECT * FROM import_jobs
      WHERE year = ? AND stage <> 'published'`,
  )
    .bind(year)
    .first<JobRow>();

  if (existing) {
    if (existing.created_by !== c.var.email) {
      // Two admins staging the same year would silently overwrite each other's
      // rows. Make it loud instead.
      return c.json(
        {
          error: `${year} 年已有 ${existing.created_by} 開始的匯入工作,請先在網頁上作廢它`,
          job_id: existing.id,
        },
        409,
      );
    }
    return c.json({ job_id: existing.id, year, stage: existing.stage, resumed: true });
  }

  // Refuse early if the year is already live. The publish gate checks this
  // too, but finding out now saves the operator a full parse.
  const clash = await c.env.DB.prepare(
    'SELECT 1 AS hit FROM questions WHERE year = ? LIMIT 1',
  )
    .bind(year)
    .first<{ hit: number }>();
  if (clash) return c.json({ error: `${year} 年題庫已存在,本工具只新增年份不覆蓋` }, 409);

  const id = crypto.randomUUID();
  const now = Date.now();
  await c.env.DB.prepare(
    `INSERT INTO import_jobs (id, year, created_by, stage, detail, created_at, updated_at)
     VALUES (?, ?, ?, 'ready', NULL, ?, ?)`,
  )
    .bind(id, year, c.var.email, now, now)
    .run();

  return c.json({ job_id: id, year, stage: 'ready', resumed: false });
});

/** POST /api/bank-ingest/jobs/:id/progress  { stage, detail } */
bankIngestRoutes.post('/jobs/:id/progress', async (c) => {
  const job = await loadJob(c, c.req.param('id'));
  if (!job || job.created_by !== c.var.email) return c.json({ error: 'not found' }, 404);
  if (job.stage === 'published') {
    return c.json({ error: `job is already ${job.stage}` }, 409);
  }

  const body = await c.req.json<{ stage?: unknown; detail?: unknown }>().catch(() => ({}) as Record<string, never>);
  const stage = String(body.stage ?? '') as Stage;
  if (!SKILL_STAGES.includes(stage)) {
    return c.json({ error: `stage must be one of ${SKILL_STAGES.join('|')}` }, 400);
  }
  const detail = typeof body.detail === 'string' ? body.detail.slice(0, 300) : null;

  await c.env.DB.prepare(
    'UPDATE import_jobs SET stage = ?, detail = ?, updated_at = ? WHERE id = ?',
  )
    .bind(stage, detail, Date.now(), job.id)
    .run();

  return c.json({ ok: true, stage, detail });
});

/**
 * POST /api/bank-ingest/jobs/:id/questions  { questions: [...] }
 *
 * Chunked upsert into staging. Invalid questions are REPORTED, not silently
 * dropped — the skill prints them so the operator can see what its parser
 * produced, rather than discovering a short year at publish time.
 */
bankIngestRoutes.post('/jobs/:id/questions', async (c) => {
  const job = await loadJob(c, c.req.param('id'));
  if (!job || job.created_by !== c.var.email) return c.json({ error: 'not found' }, 404);
  if (job.stage === 'published') {
    return c.json({ error: `job is already ${job.stage}` }, 409);
  }

  const body = await c.req.json<{ questions?: unknown }>().catch(() => ({}) as Record<string, never>);
  if (!Array.isArray(body.questions)) return c.json({ error: 'questions must be an array' }, 400);
  if (body.questions.length > 120) return c.json({ error: 'send at most 120 questions per call' }, 413);

  const comp = buildGroupComposition(c.env.GROUPS);
  if (comp.total === 0) return c.json({ error: 'GROUPS is not configured on the worker' }, 503);

  const accepted: StagedQuestion[] = [];
  const rejected: Array<{ number: unknown; errors: string[] }> = [];
  for (const raw of body.questions) {
    const { errors, value } = validateStaged(raw, comp);
    if (value) accepted.push(value);
    else rejected.push({ number: (raw as { number?: unknown })?.number ?? null, errors });
  }

  if (accepted.length) {
    const now = Date.now();
    await c.env.DB.batch([
      ...accepted.map((q) =>
        c.env.DB.prepare(
          `INSERT INTO import_staging (job_id, number, payload) VALUES (?, ?, ?)
           ON CONFLICT(job_id, number) DO UPDATE SET payload = excluded.payload`,
        ).bind(job.id, q.number, JSON.stringify(q)),
      ),
      c.env.DB.prepare('UPDATE import_jobs SET updated_at = ? WHERE id = ?').bind(now, job.id),
    ]);
  }

  const { total, review } = await recount(c.env.DB, job.id);
  await c.env.DB.prepare(
    'UPDATE import_jobs SET question_count = ?, needs_review = ?, updated_at = ? WHERE id = ?',
  )
    .bind(total, review, Date.now(), job.id)
    .run();

  return c.json({ accepted: accepted.length, rejected, staged: total, needs_review: review });
});

/** POST /api/bank-ingest/jobs/:id/complete — skill is done pushing. */
bankIngestRoutes.post('/jobs/:id/complete', async (c) => {
  const job = await loadJob(c, c.req.param('id'));
  if (!job || job.created_by !== c.var.email) return c.json({ error: 'not found' }, 404);
  if (job.stage === 'published') {
    return c.json({ error: `job is already ${job.stage}` }, 409);
  }

  const { total, review } = await recount(c.env.DB, job.id);
  await c.env.DB.prepare(
    `UPDATE import_jobs
        SET stage = 'pushed', question_count = ?, needs_review = ?, detail = NULL, updated_at = ?
      WHERE id = ?`,
  )
    .bind(total, review, Date.now(), job.id)
    .run();

  return c.json({ ok: true, stage: 'pushed', staged: total, needs_review: review });
});

/**
 * POST /api/bank-ingest/image  (multipart: file, year)
 *
 * Figures pulled out of the source PDFs. Same R2 bucket and same `/img/<key>`
 * proxy as everything else — the bucket stays private, reads still go through
 * Access. Returns the key so the skill can reference it inside explanation
 * markdown before converting to TipTap.
 */
const IMAGE_MIME_TO_EXT: Record<string, string> = {
  'image/webp': 'webp',
  'image/png': 'png',
  'image/jpeg': 'jpg',
};

bankIngestRoutes.post('/image', async (c) => {
  const fd = await c.req.formData();
  const file = fd.get('file') as unknown as (Blob & { type: string; size: number }) | string | null;
  const year = parseYear(fd.get('year'));
  if (year === null) return c.json({ error: 'year is required' }, 400);
  if (!file || typeof file === 'string') return c.json({ error: 'no file' }, 400);
  if (file.size > 5_000_000) return c.json({ error: 'image must be <5MB' }, 413);

  const ext = IMAGE_MIME_TO_EXT[file.type.toLowerCase()];
  if (!ext) return c.json({ error: 'webp/png/jpeg only' }, 415);

  const bytes = new Uint8Array(await file.arrayBuffer());
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const sha = [...new Uint8Array(digest)]
    .slice(0, 8)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  const key = `years/${year}/${sha}.${ext}`;

  await c.env.R2.put(key, bytes, {
    httpMetadata: { contentType: file.type },
    customMetadata: { uploadedBy: c.var.email },
  });

  return c.json({ ok: true, key, url: `/img/${key}` });
});

// ===========================================================================
// Group 2 — the browser's review + publish surface (Access + ADMIN_EMAILS)
// ===========================================================================

export const bankAdminRoutes = new Hono<AppContext>();

bankAdminRoutes.use('*', async (c, next) => {
  if (!isAdminEmail(c.var.email, c.env)) return c.json({ error: 'forbidden' }, 403);
  await next();
});

/**
 * GET /api/admin/import-year/status
 *
 * One call drives the whole wizard: which step to show, whether the laptop is
 * alive, and whether a staged year is waiting for review.
 */
bankAdminRoutes.get('/status', async (c) => {
  const email = c.var.email;
  const [user, live] = await Promise.all([
    c.env.DB.prepare(
      'SELECT bank_key_version, bank_last_seen_at FROM users WHERE email = ?',
    )
      .bind(email)
      .first<{ bank_key_version: number; bank_last_seen_at: number | null }>(),
    c.env.DB.prepare(
      `SELECT * FROM import_jobs
        WHERE stage <> 'published'
        ORDER BY updated_at DESC`,
    ).all<JobRow>(),
  ]);

  return c.json({
    configured: !!c.env.BANK_KEY_SECRET,
    key_version: user?.bank_key_version ?? 1,
    last_seen_at: user?.bank_last_seen_at ?? null,
    jobs: live.results ?? [],
    server_now: Date.now(),
  });
});

/** GET /api/admin/import-year/:id — the job plus every staged question. */
bankAdminRoutes.get('/:id', async (c) => {
  const job = await loadJob(c, c.req.param('id'));
  if (!job) return c.json({ error: 'not found' }, 404);

  const { results } = await c.env.DB.prepare(
    'SELECT number, payload FROM import_staging WHERE job_id = ? ORDER BY number',
  )
    .bind(job.id)
    .all<{ number: number; payload: string }>();

  const questions = (results ?? []).map((r) => {
    try {
      return JSON.parse(r.payload) as StagedQuestion;
    } catch {
      return { number: r.number, broken: true } as unknown as StagedQuestion;
    }
  });

  const comp = buildGroupComposition(c.env.GROUPS);
  return c.json({
    job,
    questions,
    blockers: assertPublishable(questions, comp),
    expected_total: comp.total,
  });
});

/**
 * PATCH /api/admin/import-year/:id/questions/:number  { answer }
 *
 * The review step's only edit. A question the parser gave up on can't be
 * published until a human picks a letter, and making them re-run the whole
 * ingest for one missing answer would be absurd.
 *
 * Deliberately answer-only: stem/option typos are already handled after
 * publish by the in-app feedback → fix-bank flow, so duplicating a full
 * question editor here would be a second place to maintain.
 */
bankAdminRoutes.patch('/:id/questions/:number', async (c) => {
  const job = await loadJob(c, c.req.param('id'));
  if (!job) return c.json({ error: 'not found' }, 404);
  if (job.stage === 'published') {
    return c.json({ error: `job is already ${job.stage}` }, 409);
  }

  const number = Number(c.req.param('number'));
  const body = await c.req.json<{ answer?: unknown }>().catch(() => ({}) as Record<string, never>);
  const answer = String(body.answer ?? '').trim().toUpperCase();
  if (!/^[A-E]$/.test(answer)) return c.json({ error: 'answer must be A-E' }, 400);

  const row = await c.env.DB.prepare(
    'SELECT payload FROM import_staging WHERE job_id = ? AND number = ?',
  )
    .bind(job.id, number)
    .first<{ payload: string }>();
  if (!row) return c.json({ error: 'not found' }, 404);

  const q = JSON.parse(row.payload) as StagedQuestion;
  if (!q.options?.[answer]) {
    return c.json({ error: `${answer} is not an option of Q${number}` }, 400);
  }

  // A human picked it, so it is by definition certain — this is what clears
  // the needs_review flag and lets the year publish.
  const next: StagedQuestion = { ...q, answer, confidence: 1 };
  await c.env.DB.prepare('UPDATE import_staging SET payload = ? WHERE job_id = ? AND number = ?')
    .bind(JSON.stringify(next), job.id, number)
    .run();

  const { total, review } = await recount(c.env.DB, job.id);
  await c.env.DB.prepare(
    'UPDATE import_jobs SET question_count = ?, needs_review = ?, updated_at = ? WHERE id = ?',
  )
    .bind(total, review, Date.now(), job.id)
    .run();

  return c.json({ ok: true, question: next, needs_review: review });
});

/**
 * POST /api/admin/import-year/:id/publish
 *
 * The only path from staging into the live bank.
 *
 * INSERT-only, never UPSERT, and refuses outright if the year already has any
 * question. That is not just tidiness: the CSV importer's upsert had to grow a
 * `CASE WHEN answer_history IS NULL` guard because a re-import silently
 * clobbered answers the community had already revised through the challenge
 * flow. Refusing to touch an existing year makes that class of bug
 * unreachable here rather than guarded against.
 */
bankAdminRoutes.post('/:id/publish', async (c) => {
  const job = await loadJob(c, c.req.param('id'));
  if (!job) return c.json({ error: 'not found' }, 404);
  if (job.stage === 'published') return c.json({ error: 'already published' }, 409);

  const clash = await c.env.DB.prepare(
    'SELECT COUNT(*) AS n FROM questions WHERE year = ?',
  )
    .bind(job.year)
    .first<{ n: number }>();
  if ((clash?.n ?? 0) > 0) {
    return c.json(
      { error: `${job.year} 年題庫已有 ${clash?.n} 題,本工具只新增年份、不覆蓋既有題目` },
      409,
    );
  }

  const { results } = await c.env.DB.prepare(
    'SELECT payload FROM import_staging WHERE job_id = ? ORDER BY number',
  )
    .bind(job.id)
    .all<{ payload: string }>();

  const questions: StagedQuestion[] = [];
  for (const r of results ?? []) {
    try {
      questions.push(JSON.parse(r.payload) as StagedQuestion);
    } catch {
      return c.json({ error: 'a staged question is corrupt; re-run the ingest' }, 500);
    }
  }

  const comp = buildGroupComposition(c.env.GROUPS);
  const blockers = assertPublishable(questions, comp);
  if (blockers.length) return c.json({ error: 'not publishable', blockers }, 400);

  const now = Date.now();
  const author = `import@${job.created_by}`;
  const ops: D1PreparedStatement[] = [];

  for (const q of questions) {
    const id = makeQuestionId(job.year, q.number);
    const options = (['A', 'B', 'C', 'D', 'E'] as const)
      .filter((k) => q.options[k])
      .map((k) => ({ key: k, text: q.options[k] }));

    ops.push(
      c.env.DB.prepare(
        `INSERT INTO questions (id, year, number, stem, options_json, answer, "group", source, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        id,
        job.year,
        q.number,
        q.stem,
        JSON.stringify(options),
        q.answer,
        q.group,
        `bank-ingest by ${job.created_by}`,
        now,
      ),
    );

    for (const tag of q.tags) {
      ops.push(
        c.env.DB.prepare(
          `INSERT INTO question_tags (question_id, tag, created_by, created_at)
           VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING`,
        ).bind(id, tag, author, now),
      );
    }

    if (q.explanation_doc) {
      ops.push(
        c.env.DB.prepare(
          `INSERT INTO explanations (question_id, content_json, version, updated_by, updated_at)
           VALUES (?, ?, 1, ?, ?)`,
        ).bind(id, JSON.stringify(q.explanation_doc), author, now),
      );
    }
  }

  ops.push(
    c.env.DB.prepare(
      `UPDATE import_jobs SET stage = 'published', detail = NULL, updated_at = ? WHERE id = ?`,
    ).bind(now, job.id),
  );

  // One batch = one implicit transaction. A half-imported year would be worse
  // than no year at all, so we do not chunk: either the whole cohort lands or
  // nothing does, and the job only flips to `published` inside the same batch.
  await c.env.DB.batch(ops);

  return c.json({
    ok: true,
    year: job.year,
    published: questions.length,
    explanations: questions.filter((q) => q.explanation_doc).length,
  });
});

/** POST /api/admin/import-year/:id/discard — throw the staged year away. */
bankAdminRoutes.post('/:id/discard', async (c) => {
  const job = await loadJob(c, c.req.param('id'));
  if (!job) return c.json({ error: 'not found' }, 404);
  if (job.stage === 'published') return c.json({ error: 'already published' }, 409);

  // ON DELETE CASCADE clears import_staging.
  await c.env.DB.prepare('DELETE FROM import_jobs WHERE id = ?').bind(job.id).run();
  return c.json({ ok: true });
});

import { Hono } from 'hono';
import type { AppContext } from '../types';
import { readIdemKey, idemLookup, idemRecordOp } from '../lib/idempotency';

export const lectureRoutes = new Hono<AppContext>();

// ── Registry ──────────────────────────────────────────────────────────

// List all lecture docs, ordered by sort_order, joined with the caller's
// own annotation/note counts.
lectureRoutes.get('/', async (c) => {
  const email = c.var.email;
  const { results } = await c.env.DB
    .prepare(
      `SELECT d.*,
        (SELECT COUNT(*) FROM lecture_annotations a WHERE a.slug = d.slug AND a.user_email = ?1) AS anno_count,
        (SELECT COUNT(*) FROM lecture_notes n WHERE n.slug = d.slug AND n.user_email = ?1) AS note_count
       FROM lecture_docs d
       ORDER BY d.sort_order`
    )
    .bind(email)
    .all();

  return c.json(results ?? []);
});

// ── Search ──────────────────────────────────────────────────────────
//
// Full-text search across lecture content (migration 0016). Two scopes:
//
//   scope=pdf    → lecture_pages_fts (shared across users)
//   scope=notes  → lecture_notes_fts filtered by caller email (per-user)
//
// Each result is a (slug, page) match with a snippet. FTS5's snippet()
// wraps matches with char(1)/char(2) markers (instead of <mark>/</mark>)
// so the client can render them as React elements without exposing PDF
// or note text to dangerouslySetInnerHTML — XSS-safe by construction.
// Results are joined back to lecture_docs for title/instructor display.
// Frontend uses (slug, page) to deep-link via /lectures/:slug?page=N.
//
// Declared BEFORE the /:slug route so it isn't swallowed by the param.
lectureRoutes.get('/search', async (c) => {
  const qRaw = (c.req.query('q') ?? '').trim();
  const scope = c.req.query('scope') === 'notes' ? 'notes' : 'pdf';
  const limit = Math.min(
    50,
    Math.max(1, parseInt(c.req.query('limit') ?? '20', 10) || 20),
  );
  // Optional slug filter — used by the in-reader search box on /lectures/:slug
  // to restrict results to the lecture currently being read.
  const slugFilter = (c.req.query('slug') ?? '').trim();
  const hasSlug = slugFilter.length > 0;

  if (qRaw.length === 0) {
    return c.json({ results: [], scope, q: qRaw });
  }

  // FTS5 query sanitisation: strip operator chars and wrap each token as a
  // phrase so user input can't trigger syntax errors or unexpected boolean
  // behaviour. Tokens implicitly AND. Empty → no match → []
  const ftsQuery = qRaw
    .replace(/["()*:]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => '"' + t + '"')
    .join(' ');

  if (ftsQuery.length === 0) {
    return c.json({ results: [], scope, q: qRaw });
  }

  let results: unknown[];
  if (scope === 'notes') {
    const email = c.var.email;
    const sql = `SELECT
       n.slug AS slug,
       CAST(n.page AS INTEGER) AS page,
       d.title AS title,
       d.instructor AS instructor,
       snippet(lecture_notes_fts, 3, char(1), char(2), '…', 16) AS snippet
     FROM lecture_notes_fts n
     JOIN lecture_docs d ON d.slug = n.slug
     WHERE lecture_notes_fts MATCH ?1
       AND n.user_email = ?2
       ${hasSlug ? 'AND n.slug = ?3' : ''}
     ORDER BY bm25(lecture_notes_fts), d.sort_order, n.page
     LIMIT ${hasSlug ? '?4' : '?3'}`;
    const stmt = c.env.DB.prepare(sql);
    const r = await (hasSlug
      ? stmt.bind(ftsQuery, email, slugFilter, limit)
      : stmt.bind(ftsQuery, email, limit)
    ).all();
    results = r.results ?? [];
  } else {
    const sql = `SELECT
       p.slug AS slug,
       CAST(p.page AS INTEGER) AS page,
       d.title AS title,
       d.instructor AS instructor,
       snippet(lecture_pages_fts, 2, char(1), char(2), '…', 16) AS snippet
     FROM lecture_pages_fts p
     JOIN lecture_docs d ON d.slug = p.slug
     WHERE lecture_pages_fts MATCH ?1
       ${hasSlug ? 'AND p.slug = ?2' : ''}
     ORDER BY bm25(lecture_pages_fts), d.sort_order, p.page
     LIMIT ${hasSlug ? '?3' : '?2'}`;
    const stmt = c.env.DB.prepare(sql);
    const r = await (hasSlug
      ? stmt.bind(ftsQuery, slugFilter, limit)
      : stmt.bind(ftsQuery, limit)
    ).all();
    results = r.results ?? [];
  }

  return c.json({ results, scope, q: qRaw, slug: hasSlug ? slugFilter : undefined });
});

// Single doc metadata + derived /pdf URL.
lectureRoutes.get('/:slug', async (c) => {
  const slug = c.req.param('slug');
  const row = await c.env.DB
    .prepare('SELECT * FROM lecture_docs WHERE slug = ?')
    .bind(slug)
    .first<{ r2_key: string }>();

  if (!row) return c.json({ error: 'not found' }, 404);

  return c.json({ ...row, pdf_url: '/pdf/' + row.r2_key });
});

// ── Annotations (highlights + sticky notes) ──────────────────────────

// All of the caller's annotations for a slug.
lectureRoutes.get('/:slug/annotations', async (c) => {
  const slug = c.req.param('slug');
  const email = c.var.email;
  const { results } = await c.env.DB
    .prepare(
      `SELECT * FROM lecture_annotations
       WHERE slug = ? AND user_email = ?
       ORDER BY page, created_at`
    )
    .bind(slug, email)
    .all<any>();

  const rows = (results ?? []).map((r: any) => ({
    ...r,
    payload_json: safeParse(r.payload_json),
  }));
  return c.json(rows);
});

// Create an annotation.
lectureRoutes.post('/:slug/annotations', async (c) => {
  const slug = c.req.param('slug');
  const email = c.var.email;

  // 冪等:重送同一 key 直接 replay,不重複建立註記。
  const idemKey = readIdemKey(c);
  if (idemKey) {
    const hit = await idemLookup(c.env.DB, email, idemKey);
    if (hit) return c.json(hit.body as any, hit.status as any);
  }

  const body = await c.req.json<{ kind: string; page: number; payload_json: any }>();

  const id = crypto.randomUUID();
  const now = Date.now();
  const payload = JSON.stringify(body.payload_json);

  const responseBody = {
    id,
    user_email: email,
    slug,
    page: body.page,
    kind: body.kind,
    payload_json: body.payload_json,
    created_at: now,
    updated_at: now,
  };
  // 註記 INSERT 與去重列走同一個 batch,原子提交。
  const ops = [
    c.env.DB
      .prepare(
        `INSERT INTO lecture_annotations
         (id, user_email, slug, page, kind, payload_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(id, email, slug, body.page, body.kind, payload, now, now),
  ];
  if (idemKey) {
    ops.push(
      idemRecordOp(c.env.DB, {
        email,
        key: idemKey,
        endpoint: 'POST /lectures/:slug/annotations',
        status: 200,
        body: responseBody,
        now,
      })
    );
  }
  await c.env.DB.batch(ops);

  return c.json(responseBody);
});

// Update an annotation's payload (and page if provided). Ownership-checked.
lectureRoutes.patch('/:slug/annotations/:id', async (c) => {
  const id = c.req.param('id');
  const email = c.var.email;
  const body = await c.req.json<{ payload_json?: any; page?: number }>();

  const now = Date.now();
  const sets: string[] = ['updated_at = ?'];
  const binds: any[] = [now];
  if ('payload_json' in body) {
    sets.push('payload_json = ?');
    binds.push(JSON.stringify(body.payload_json));
  }
  if (typeof body.page === 'number') {
    sets.push('page = ?');
    binds.push(body.page);
  }
  binds.push(id, email);

  const res = await c.env.DB
    .prepare(
      `UPDATE lecture_annotations SET ${sets.join(', ')}
       WHERE id = ? AND user_email = ?`
    )
    .bind(...binds)
    .run();

  if ((res.meta?.changes ?? 0) === 0) return c.json({ error: 'not found' }, 404);
  return c.json({ ok: true, updated_at: now });
});

// Delete an annotation. Ownership-checked.
lectureRoutes.delete('/:slug/annotations/:id', async (c) => {
  const id = c.req.param('id');
  const email = c.var.email;
  const res = await c.env.DB
    .prepare('DELETE FROM lecture_annotations WHERE id = ? AND user_email = ?')
    .bind(id, email)
    .run();

  if ((res.meta?.changes ?? 0) === 0) return c.json({ error: 'not found' }, 404);
  return c.json({ ok: true });
});

// ── Notebook (page-anchored TipTap notes) ────────────────────────────

// All of the caller's notes for a slug.
lectureRoutes.get('/:slug/notes', async (c) => {
  const slug = c.req.param('slug');
  const email = c.var.email;
  const { results } = await c.env.DB
    .prepare(
      `SELECT * FROM lecture_notes
       WHERE slug = ? AND user_email = ?
       ORDER BY created_at`
    )
    .bind(slug, email)
    .all<any>();

  const rows = (results ?? []).map((r: any) => ({
    ...r,
    content_json: safeParse(r.content_json),
  }));
  return c.json(rows);
});

// Create a note. page may be null (deck-level note).
lectureRoutes.post('/:slug/notes', async (c) => {
  const slug = c.req.param('slug');
  const email = c.var.email;

  // 冪等:重送同一 key 直接 replay,不重複建立筆記。
  const idemKey = readIdemKey(c);
  if (idemKey) {
    const hit = await idemLookup(c.env.DB, email, idemKey);
    if (hit) return c.json(hit.body as any, hit.status as any);
  }

  const body = await c.req.json<{ page: number | null; content_json: any }>();

  const id = crypto.randomUUID();
  const now = Date.now();
  const content = JSON.stringify(body.content_json);
  const page = body.page ?? null;

  const responseBody = {
    id,
    user_email: email,
    slug,
    page,
    content_json: body.content_json,
    created_at: now,
    updated_at: now,
  };
  // 筆記 INSERT 與去重列走同一個 batch,原子提交。
  const ops = [
    c.env.DB
      .prepare(
        `INSERT INTO lecture_notes
         (id, user_email, slug, page, content_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(id, email, slug, page, content, now, now),
  ];
  if (idemKey) {
    ops.push(
      idemRecordOp(c.env.DB, {
        email,
        key: idemKey,
        endpoint: 'POST /lectures/:slug/notes',
        status: 200,
        body: responseBody,
        now,
      })
    );
  }
  await c.env.DB.batch(ops);

  return c.json(responseBody);
});

// Upsert exactly one note for (user, slug, page). No DB unique constraint
// exists, so this is an app-level read-then-write.
lectureRoutes.put('/:slug/notes/by-page/:page', async (c) => {
  const slug = c.req.param('slug');
  const page = Number(c.req.param('page'));
  const email = c.var.email;
  const { content_json } = await c.req.json<{ content_json: any }>();

  const now = Date.now();
  const content = JSON.stringify(content_json);

  const existing = await c.env.DB
    .prepare(
      'SELECT id, created_at FROM lecture_notes WHERE user_email = ? AND slug = ? AND page = ?'
    )
    .bind(email, slug, page)
    .first<{ id: string; created_at: number }>();

  if (existing) {
    await c.env.DB
      .prepare('UPDATE lecture_notes SET content_json = ?, updated_at = ? WHERE id = ?')
      .bind(content, now, existing.id)
      .run();
    return c.json({
      id: existing.id,
      user_email: email,
      slug,
      page,
      content_json,
      created_at: existing.created_at,
      updated_at: now,
    });
  }

  const id = crypto.randomUUID();
  await c.env.DB
    .prepare(
      `INSERT INTO lecture_notes
         (id, user_email, slug, page, content_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(id, email, slug, page, content, now, now)
    .run();

  return c.json({
    id,
    user_email: email,
    slug,
    page,
    content_json,
    created_at: now,
    updated_at: now,
  });
});

// Update a note's content (and page if provided). Ownership-checked.
lectureRoutes.patch('/:slug/notes/:id', async (c) => {
  const id = c.req.param('id');
  const email = c.var.email;
  const body = await c.req.json<{ content_json?: any; page?: number | null }>();

  const now = Date.now();
  const sets: string[] = ['content_json = ?', 'updated_at = ?'];
  const binds: any[] = [JSON.stringify(body.content_json), now];
  if ('page' in body) {
    sets.push('page = ?');
    binds.push(body.page ?? null);
  }
  binds.push(id, email);

  const res = await c.env.DB
    .prepare(
      `UPDATE lecture_notes SET ${sets.join(', ')}
       WHERE id = ? AND user_email = ?`
    )
    .bind(...binds)
    .run();

  if ((res.meta?.changes ?? 0) === 0) return c.json({ error: 'not found' }, 404);
  return c.json({ ok: true, updated_at: now });
});

// Delete a note. Ownership-checked.
lectureRoutes.delete('/:slug/notes/:id', async (c) => {
  const id = c.req.param('id');
  const email = c.var.email;
  const res = await c.env.DB
    .prepare('DELETE FROM lecture_notes WHERE id = ? AND user_email = ?')
    .bind(id, email)
    .run();

  if ((res.meta?.changes ?? 0) === 0) return c.json({ error: 'not found' }, 404);
  return c.json({ ok: true });
});

function safeParse(raw: unknown): any {
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

import { Hono } from 'hono';
import type { AppContext } from '../types';

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
  const body = await c.req.json<{ kind: string; page: number; payload_json: any }>();

  const id = crypto.randomUUID();
  const now = Date.now();
  const payload = JSON.stringify(body.payload_json);

  await c.env.DB
    .prepare(
      `INSERT INTO lecture_annotations
         (id, user_email, slug, page, kind, payload_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(id, email, slug, body.page, body.kind, payload, now, now)
    .run();

  return c.json({
    id,
    user_email: email,
    slug,
    page: body.page,
    kind: body.kind,
    payload_json: body.payload_json,
    created_at: now,
    updated_at: now,
  });
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
  const body = await c.req.json<{ page: number | null; content_json: any }>();

  const id = crypto.randomUUID();
  const now = Date.now();
  const content = JSON.stringify(body.content_json);
  const page = body.page ?? null;

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
    content_json: body.content_json,
    created_at: now,
    updated_at: now,
  });
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

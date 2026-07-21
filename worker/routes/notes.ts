import { Hono } from 'hono';
import type { AppContext } from '../types';
import { loadVocab, computeNoteSuggestions } from '../lib/note-links';

export const notesRoutes = new Hono<AppContext>();

// Upsert this user's private note for a question. Flag needs_relink=1 so the
// 關聯連結 建議 gets (re)computed — lazily on next read of /note/links, and in
// the nightly cron drain. See docs/plans/2026-07-21-note-link-suggestions-design.md
notesRoutes.put('/:id/note', async (c) => {
  const id = c.req.param('id');
  const email = c.var.email;
  const body = await c.req.json<{ content_json: any }>();

  const now = Date.now();
  const json = JSON.stringify(body.content_json);

  await c.env.DB
    .prepare(
      `INSERT INTO personal_notes (user_email, question_id, content_json, updated_at, needs_relink)
       VALUES (?, ?, ?, ?, 1)
       ON CONFLICT(user_email, question_id) DO UPDATE SET
         content_json = excluded.content_json,
         updated_at   = excluded.updated_at,
         needs_relink = 1`
    )
    .bind(email, id, json, now)
    .run();

  return c.json({ ok: true, updated_at: now });
});

// Remove this user's note. note_terms / note_link_suggestions FK-cascade off
// personal_notes; delete explicitly too so we don't depend on PRAGMA state.
notesRoutes.delete('/:id/note', async (c) => {
  const id = c.req.param('id');
  const email = c.var.email;
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM note_terms WHERE user_email = ? AND question_id = ?').bind(email, id),
    c.env.DB.prepare('DELETE FROM note_link_suggestions WHERE user_email = ? AND question_id = ?').bind(email, id),
    c.env.DB.prepare('DELETE FROM personal_notes WHERE user_email = ? AND question_id = ?').bind(email, id),
  ]);
  return c.json({ ok: true });
});

// 關聯連結 建議 for this user's note on :id. Cached in note_link_suggestions;
// if the note is dirty (edited since last compute) we recompute on the spot —
// single note, deterministic SQL, zero Workers AI neurons — so suggestions feel
// live without waiting for the nightly cron.
type NoteLinkRow = {
  target_kind: 'note' | 'question';
  target_id: string;
  score: number;
  shared_terms: string;
  year: number;
  number: number;
  stem: string;
  group: string | null;
};

notesRoutes.get('/:id/note/links', async (c) => {
  const id = c.req.param('id');
  const email = c.var.email;

  const note = await c.env.DB
    .prepare('SELECT content_json, needs_relink FROM personal_notes WHERE user_email = ? AND question_id = ?')
    .bind(email, id)
    .first<{ content_json: string; needs_relink: number }>();
  if (!note) return c.json({ links: [] });

  if (note.needs_relink) {
    try {
      const vocab = await loadVocab(c.env.DB);
      await computeNoteSuggestions(c.env.DB, email, id, note.content_json, vocab);
    } catch (e) {
      // Non-fatal: fall through to whatever is cached (possibly empty).
      console.warn('note-links lazy compute failed', id, String(e));
    }
  }

  const { results } = await c.env.DB
    .prepare(
      `SELECT s.target_kind, s.target_id, s.score, s.shared_terms,
              q.year, q.number, q.stem, q."group"
         FROM note_link_suggestions s
         JOIN questions q ON q.id = s.target_id
        WHERE s.user_email = ? AND s.question_id = ?
          AND (s.target_kind = 'question'
               OR EXISTS (SELECT 1 FROM personal_notes pn
                           WHERE pn.user_email = s.user_email
                             AND pn.question_id = s.target_id))
        ORDER BY s.score DESC`
    )
    .bind(email, id)
    .all<NoteLinkRow>();

  const links = (results ?? []).map((r) => {
    let sharedTerms: string[] = [];
    try {
      const v = JSON.parse(r.shared_terms);
      if (Array.isArray(v)) sharedTerms = v.filter((x) => typeof x === 'string');
    } catch { /* keep [] */ }
    return {
      targetKind: r.target_kind,
      targetId: r.target_id,
      year: r.year,
      number: r.number,
      stem: r.stem,
      group: r.group,
      sharedTerms,
    };
  });

  return c.json({ links });
});

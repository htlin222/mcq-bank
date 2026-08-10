import { Hono } from 'hono';
import type { AppContext } from '../types';
import { loadVocab, computeNoteSuggestions, loadSuggestions } from '../lib/note-links';
import { MAX_NOTES_PER_QUESTION, parseSlot, resolveNoteOrder } from '../lib/notes';

export const notesRoutes = new Hono<AppContext>();

// Upsert this user's private note for a question. Flag needs_relink=1 so the
// 關聯連結 建議 gets (re)computed — lazily on next read of /note/links, and in
// the nightly cron drain. See docs/plans/2026-07-21-note-link-suggestions-design.md
notesRoutes.put('/:id/note', async (c) => {
  const id = c.req.param('id');
  const email = c.var.email;
  const body = await c.req.json<{ content_json: any; slot?: unknown }>();
  const slot = parseSlot(body.slot);

  const now = Date.now();
  const json = JSON.stringify(body.content_json);

  await c.env.DB
    .prepare(
      `INSERT INTO personal_notes (user_email, question_id, slot, content_json, created_at, updated_at, needs_relink)
       VALUES (?, ?, ?, ?, ?, ?, 1)
       ON CONFLICT(user_email, question_id, slot) DO UPDATE SET
         content_json = excluded.content_json,
         updated_at   = excluded.updated_at,
         needs_relink = 1`
    )
    .bind(email, id, slot, json, now, now)
    .run();

  return c.json({ ok: true, slot, updated_at: now });
});

// 新增一則筆記。slot 取現有最大值 +1 —— 不重用被刪掉的號碼,因為畫記
// (highlights.store_key = anno:note:<qid>:<slot>)與挖空快取都以 slot 定位,
// 重用會讓新筆記繼承上一則的標記。
notesRoutes.post('/:id/notes', async (c) => {
  const id = c.req.param('id');
  const email = c.var.email;
  const body = await c.req
    .json<{ content_json?: any }>()
    .catch(() => ({}) as { content_json?: any });
  const doc = body.content_json ?? { type: 'doc', content: [{ type: 'paragraph' }] };

  const exists = await c.env.DB.prepare('SELECT id FROM questions WHERE id = ?').bind(id).first();
  if (!exists) return c.json({ error: 'question not found', id }, 404);

  const row = await c.env.DB
    .prepare(
      'SELECT MAX(slot) AS max_slot, COUNT(*) AS n FROM personal_notes WHERE user_email = ? AND question_id = ?'
    )
    .bind(email, id)
    .first<{ max_slot: number | null; n: number }>();
  if ((row?.n ?? 0) >= MAX_NOTES_PER_QUESTION) {
    return c.json({ error: 'too many notes', max: MAX_NOTES_PER_QUESTION }, 409);
  }
  const slot = row?.max_slot == null ? 0 : row.max_slot + 1;
  if (slot >= MAX_NOTES_PER_QUESTION) {
    // 反覆新增/刪除會把號碼推高(不重用號碼是刻意的,見上面的註解)。真的
    // 撞到上限時要說清楚,而不是寫進一個 parseSlot() 之後會退回 0 的號碼。
    return c.json({ error: 'slot range exhausted', max: MAX_NOTES_PER_QUESTION }, 409);
  }

  const now = Date.now();
  await c.env.DB
    .prepare(
      `INSERT INTO personal_notes (user_email, question_id, slot, content_json, created_at, updated_at, needs_relink)
       VALUES (?, ?, ?, ?, ?, ?, 1)`
    )
    .bind(email, id, slot, JSON.stringify(doc), now, now)
    .run();

  return c.json({ ok: true, slot, created_at: now, updated_at: now }, 201);
});

// Remove one of this user's notes (?slot=N,預設 0)。note_terms /
// note_link_suggestions 是「一題一組」而非一則一組(由該題全部筆記合起來
// 算),所以只有在刪掉最後一則時才清掉;否則標成待重算。
notesRoutes.delete('/:id/note', async (c) => {
  const id = c.req.param('id');
  const email = c.var.email;
  const slot = parseSlot(c.req.query('slot') ?? 0);

  const ops = [
    c.env.DB.prepare('DELETE FROM personal_notes WHERE user_email = ? AND question_id = ? AND slot = ?').bind(email, id, slot),
    c.env.DB.prepare('DELETE FROM note_cloze WHERE user_email = ? AND question_id = ? AND slot = ?').bind(email, id, slot),
  ];
  await c.env.DB.batch(ops);

  const left = await c.env.DB
    .prepare('SELECT COUNT(*) AS n FROM personal_notes WHERE user_email = ? AND question_id = ?')
    .bind(email, id)
    .first<{ n: number }>();

  if ((left?.n ?? 0) === 0) {
    await c.env.DB.batch([
      c.env.DB.prepare("DELETE FROM note_terms WHERE user_email = ? AND owner_kind = 'question' AND owner_id = ?").bind(email, id),
      c.env.DB.prepare("DELETE FROM note_link_suggestions WHERE user_email = ? AND owner_kind = 'question' AND owner_id = ?").bind(email, id),
      // 這則筆記消失後,別人(自己的其他筆記)不該再被推薦到它。
      c.env.DB.prepare("DELETE FROM note_link_suggestions WHERE user_email = ? AND target_kind = 'note' AND target_id = ?").bind(email, id),
    ]);
  } else {
    await c.env.DB
      .prepare('UPDATE personal_notes SET needs_relink = 1 WHERE user_email = ? AND question_id = ?')
      .bind(email, id)
      .run();
  }

  return c.json({ ok: true, slot, remaining: left?.n ?? 0 });
});

// 自訂排序(#140)。body: { slots: number[] },由前到後。
//
// **整批寫,而且必須是現有 slot 的排列** —— 少一個、多一個、重複、夾帶別題的
// 號碼,一律拒絕(見 resolveNoteOrder)。放行部分正確的請求會寫出一份「有些排過、
// 有些沒有」的順序,而那在畫面上只是「排錯了」,使用者不會知道是請求壞掉。
//
// 不動 slot:它是 PK 的一部分,而 highlights 的 store_key、挖空快取、關聯建議
// 全都以它定位(見 migration 0041 的說明)。
notesRoutes.put('/:id/notes/order', async (c) => {
  const id = c.req.param('id');
  const email = c.var.email;
  const body = await c.req.json<{ slots?: unknown }>().catch(() => ({}) as { slots?: unknown });

  const rows = await c.env.DB
    .prepare('SELECT slot FROM personal_notes WHERE user_email = ? AND question_id = ?')
    .bind(email, id)
    .all<{ slot: number }>();
  const existing = (rows.results ?? []).map((r) => r.slot);
  if (!existing.length) return c.json({ error: 'no notes', id }, 404);

  const picked = resolveNoteOrder(existing, body.slots);
  if (!picked.ok) return c.json({ error: picked.error, slots: existing }, picked.status);

  // 一次 batch —— 分開送的話,中途失敗會留下一半新一半舊的順序。
  await c.env.DB.batch(
    picked.slots.map((slot, i) =>
      c.env.DB
        .prepare('UPDATE personal_notes SET sort_order = ? WHERE user_email = ? AND question_id = ? AND slot = ?')
        .bind(i, email, id, slot),
    ),
  );

  return c.json({ ok: true, slots: picked.slots });
});

// 關聯連結 建議 for this user's note on :id. Cached in note_link_suggestions;
// if the note is dirty (edited since last compute) we recompute on the spot —
// single note, deterministic SQL, zero Workers AI neurons — so suggestions feel
// live without waiting for the nightly cron.
notesRoutes.get('/:id/note/links', async (c) => {
  const id = c.req.param('id');
  const email = c.var.email;

  // 建議是「這一題的全部筆記」合起來算的,不是逐則 —— 逐則會讓同一題的
  // 幾則筆記互相推薦對方,而它們本來就在同一頁上。
  const { results: noteRows } = await c.env.DB
    .prepare('SELECT content_json, needs_relink FROM personal_notes WHERE user_email = ? AND question_id = ? ORDER BY sort_order, slot')
    .bind(email, id)
    .all<{ content_json: string; needs_relink: number }>();
  if (!noteRows?.length) return c.json({ links: [] });

  if (noteRows.some((n) => n.needs_relink)) {
    try {
      const vocab = await loadVocab(c.env.DB);
      await computeNoteSuggestions(
        c.env.DB,
        email,
        'question',
        id,
        noteRows.map((n) => n.content_json),
        vocab,
      );
    } catch (e) {
      // Non-fatal: fall through to whatever is cached (possibly empty).
      console.warn('note-links lazy compute failed', id, String(e));
    }
  }

  const links = await loadSuggestions(c.env.DB, email, 'question', id);
  return c.json({ links });
});

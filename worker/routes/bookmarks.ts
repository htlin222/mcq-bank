import { Hono } from 'hono';
import { QUESTION_ROW_COLUMNS, toQuestionRow } from '../lib/question-row';
import type { AppContext } from '../types';

export const bookmarksRoutes = new Hono<AppContext>();

/**
 * List my bookmarks, optionally filtered by folder.
 *   GET /api/bookmarks                  → all my bookmarks
 *   GET /api/bookmarks?folder=<id>      → items in a specific folder
 *   GET /api/bookmarks?folder=null      → uncategorized
 */
bookmarksRoutes.get('/', async (c) => {
  const email = c.var.email;
  const folder = c.req.query('folder');
  const source = c.req.query('source');

  // Alternate source: list questions where the user has a private note.
  // Same response shape as bookmarks so the existing UI renders unchanged.
  if (source === 'notes') {
    const { results } = await c.env.DB
      .prepare(
        // 一題多則時只出現一次,時間取最近編輯的那則(migration 0036)。
        // 列的形狀與另外幾個清單端點共用(見 lib/question-row.ts)——
        // 收藏頁現在用同一張卡,所以也要帶選項全文 / 正解 / 我上次選的。
        // ⚠️ `rp` 這個 LEFT JOIN 要自己釘 `user_email`:少了它,`last_chosen`
        // 會是**別人**的作答,而那不會報錯,只會靜靜顯示錯的答案。
        `SELECT n.question_id AS id, NULL AS folder_id, NULL AS note,
                MAX(n.updated_at) AS created_at,
                ${QUESTION_ROW_COLUMNS},
                rp.times_seen, rp.last_correct, rp.last_chosen
         FROM personal_notes n
         JOIN questions q ON q.id = n.question_id
         LEFT JOIN review_progress rp
                ON rp.question_id = q.id AND rp.user_email = ?
         WHERE n.user_email = ?
         GROUP BY n.question_id
         ORDER BY created_at DESC`
      )
      .bind(email, email)
      .all<{ options_json: string; answer: string }>();
    return c.json((results ?? []).map(toQuestionRow));
  }

  let where = 'b.user_email = ?';
  const params: any[] = [email];
  if (folder === 'null') {
    where += ' AND b.folder_id IS NULL';
  } else if (folder) {
    where += ' AND b.folder_id = ?';
    params.push(folder);
  }

  const { results } = await c.env.DB
    .prepare(
      // 同上:列的形狀共用。**`rp` 的 email 綁在 JOIN 上,所以它的參數排在
      // `where` 的參數之前** —— bind 是位置對應的(見 lib/bind-order.ts)。
      `SELECT b.question_id AS id, b.folder_id, b.note, b.created_at,
              ${QUESTION_ROW_COLUMNS},
              rp.times_seen, rp.last_correct, rp.last_chosen
       FROM bookmark_items b
       JOIN questions q ON q.id = b.question_id
       LEFT JOIN review_progress rp
              ON rp.question_id = q.id AND rp.user_email = ?
       WHERE ${where}
       ORDER BY b.created_at DESC`
    )
    .bind(email, ...params)
    .all<{ options_json: string; answer: string }>();
  return c.json((results ?? []).map(toQuestionRow));
});

// Toggle / set folder. PUT semantics: idempotent upsert.
//   body: { folder_id?: string | null, note?: string }
bookmarksRoutes.put('/:question_id', async (c) => {
  const email = c.var.email;
  const qid = c.req.param('question_id');
  const body = await c.req.json<{ folder_id?: string | null; note?: string }>();
  const now = Date.now();

  // Verify folder belongs to user (if provided)
  if (body.folder_id) {
    const ok = await c.env.DB
      .prepare('SELECT id FROM bookmark_folders WHERE id = ? AND user_email = ?')
      .bind(body.folder_id, email)
      .first();
    if (!ok) return c.json({ error: 'folder not yours' }, 403);
  }

  await c.env.DB
    .prepare(
      `INSERT INTO bookmark_items (user_email, question_id, folder_id, note, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_email, question_id) DO UPDATE SET
         folder_id = excluded.folder_id,
         note = COALESCE(excluded.note, note)`
    )
    .bind(email, qid, body.folder_id ?? null, body.note ?? null, now)
    .run();

  return c.json({ ok: true });
});

// Bulk upsert — used by the search page to save a result set into a folder.
//   body: { question_ids: string[]; folder_id?: string | null }
// Existing bookmarks for those questions get their folder_id overwritten;
// missing ones are inserted. Caps payload at 500 to protect the worker.
bookmarksRoutes.post('/bulk', async (c) => {
  const email = c.var.email;
  const body = await c.req.json<{ question_ids: string[]; folder_id?: string | null }>();
  const ids = Array.isArray(body.question_ids) ? body.question_ids.slice(0, 500) : [];
  if (ids.length === 0) return c.json({ ok: true, inserted: 0 });

  // Validate folder ownership when one is given
  if (body.folder_id) {
    const ok = await c.env.DB
      .prepare('SELECT id FROM bookmark_folders WHERE id = ? AND user_email = ?')
      .bind(body.folder_id, email)
      .first();
    if (!ok) return c.json({ error: 'folder not yours' }, 403);
  }

  const now = Date.now();
  const ops = ids.map((qid) =>
    c.env.DB
      .prepare(
        `INSERT INTO bookmark_items (user_email, question_id, folder_id, note, created_at)
         VALUES (?, ?, ?, NULL, ?)
         ON CONFLICT(user_email, question_id) DO UPDATE SET
           folder_id = excluded.folder_id`
      )
      .bind(email, qid, body.folder_id ?? null, now)
  );
  await c.env.DB.batch(ops);
  return c.json({ ok: true, inserted: ids.length });
});

// Remove bookmark
bookmarksRoutes.delete('/:question_id', async (c) => {
  const email = c.var.email;
  const qid = c.req.param('question_id');
  await c.env.DB
    .prepare('DELETE FROM bookmark_items WHERE user_email = ? AND question_id = ?')
    .bind(email, qid)
    .run();
  return c.json({ ok: true });
});

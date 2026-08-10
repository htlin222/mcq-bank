import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppContext } from '../types';

// 「備份我的紀錄」的資料來源(#123)。個人頁按下去之後,**zip 是在瀏覽器裡組的**,
// 這裡只負責把資料一頁一頁交出去。
//
// 為什麼不在 Worker 裡打包:實測單一使用者的個人筆記就有 3976 則 / 35.8 MB
// (再加上 1100 題與 1.85 MB 的共筆詳解)。free plan 一次請求 10ms CPU、128 MB
// 記憶體,`zipSync` 一次吃下 38 MB 不可能;就算改成串流 STORE,CPU 仍與資料量
// 成正比,而那是這個方案唯一真正稀缺的資源。分頁 JSON 則是這個站每天都在做的
// 事 —— 每一頁就是一次普通的 D1 讀取。
//
// **每一支查詢都釘死 `user_email = c.var.email`。** 個人筆記在畫面上寫的是
// 「僅你可見」,備份不能是那句話的例外。題目與共筆詳解是公開的,照原樣附上
// (少了題幹,作答紀錄沒有東西可分析)。
//
// 分頁一律用 keyset(`... > ?` + `ORDER BY` + `LIMIT`),不用 OFFSET:資料在
// 下載途中被改動時,OFFSET 會漏列或給重複列,而使用者不會發現。

export const backupRoutes = new Hono<AppContext>();

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;

function limitOf(c: Context<AppContext>) {
  const n = Number(c.req.query('limit') || DEFAULT_LIMIT);
  return Number.isFinite(n) ? Math.min(Math.max(1, Math.trunc(n)), MAX_LIMIT) : DEFAULT_LIMIT;
}

/**
 * 跑一頁 keyset 查詢。`sql` 的 bind 順序是 (email, after, limit),公開資料那支少一個 email(見 opts.scoped)。
 * 回 `next = null` 代表沒有下一頁 —— 用「這一頁沒有裝滿」判斷,所以最後一頁
 * 剛好裝滿時會多打一次空的請求。那比「多回一列來偷看」簡單,而且沒有邊界錯誤。
 */
async function page<T extends Record<string, unknown>>(
  c: Context<AppContext>,
  sql: string,
  cursorOf: (row: T) => string | number,
  // 題目與共筆詳解是公開的,那一支不綁 email —— bind 的順序跟著少一個。
  opts: { scoped?: boolean } = {}
) {
  const scoped = opts.scoped !== false;
  const limit = limitOf(c);
  const after = c.req.query('after') ?? '';
  const binds = scoped ? [c.var.email, after, limit] : [after, limit];
  const { results } = await c.env.DB.prepare(sql)
    .bind(...binds)
    .all<T>();
  const next = results.length === limit ? String(cursorOf(results[results.length - 1])) : null;
  return c.json({ rows: results, next });
}

// ── manifest ────────────────────────────────────────────────────────────
// 前端先拿這個決定進度條的分母,以及哪些區塊根本是空的(空的就不必發請求)。

backupRoutes.get('/manifest', async (c) => {
  const email = c.var.email;
  const one = async (sql: string, ...binds: unknown[]) => {
    const r = await c.env.DB.prepare(sql).bind(...binds).first<{ n: number }>();
    return r?.n ?? 0;
  };
  const [questions, attempts, confidence, notes, highlights, progress, bookmarks, exams, lectureAnno, lectureNotes, freeNotes] =
    await Promise.all([
      one('SELECT COUNT(*) AS n FROM questions'),
      one('SELECT COUNT(*) AS n FROM attempts WHERE user_email = ?', email),
      one('SELECT COUNT(*) AS n FROM confidence_events WHERE user_email = ?', email),
      one('SELECT COUNT(*) AS n FROM personal_notes WHERE user_email = ?', email),
      one('SELECT COUNT(*) AS n FROM highlights WHERE user_email = ?', email),
      one('SELECT COUNT(*) AS n FROM review_progress WHERE user_email = ?', email),
      one('SELECT COUNT(*) AS n FROM bookmark_items WHERE user_email = ?', email),
      one('SELECT COUNT(*) AS n FROM exam_sessions WHERE user_email = ?', email),
      one('SELECT COUNT(*) AS n FROM lecture_annotations WHERE user_email = ?', email),
      one('SELECT COUNT(*) AS n FROM lecture_notes WHERE user_email = ?', email),
      one('SELECT COUNT(*) AS n FROM free_notes WHERE user_email = ?', email),
    ]);

  return c.json({
    email,
    generated_at: Date.now(),
    // 讀這份備份的人(或 Claude)要知道欄位長什麼樣。改變任何一支端點的形狀
    // 就把它 +1,並在 CLAUDE.md 裡說明差在哪。
    schema_version: 1,
    counts: {
      questions,
      attempts,
      confidence,
      notes,
      highlights,
      progress,
      bookmarks,
      exams,
      lecture_annotations: lectureAnno,
      lecture_notes: lectureNotes,
      free_notes: freeNotes,
    },
  });
});

// ── 題目 + 共筆詳解(公開資料) ──────────────────────────────────────────

backupRoutes.get('/questions', (c) =>
  page<{ id: string }>(
    c,
    `SELECT q.id, q.year, q.number, q."group", q.stem, q.options_json, q.answer,
            e.content_json AS explanation_json, e.version AS explanation_version,
            e.updated_by AS explanation_updated_by, e.updated_at AS explanation_updated_at
       FROM questions q
       LEFT JOIN explanations e ON e.question_id = q.id
      WHERE q.id > ?
      ORDER BY q.id
      LIMIT ?`,
    (r) => r.id,
    { scoped: false }
  )
);

// ── 複習:作答 / 信心 / 筆記 / 畫記 / 進度 ──────────────────────────────
//
// 刻意**不**在伺服器端組成「一題一包」。組裝是純粹的資料重排,client 做零成本;
// 放在這裡的話每一頁都要跨五張表 join,而分頁邊界會落在題目中間 —— 一題的紀錄
// 被切成兩頁,重組的複雜度反而跑到 client 身上。

backupRoutes.get('/attempts', (c) =>
  page<{ id: number }>(
    c,
    `SELECT id, question_id, chosen, is_correct, source, session_id, elapsed_ms, created_at
       FROM attempts
      WHERE user_email = ? AND id > CAST(? AS INTEGER)
      ORDER BY id
      LIMIT ?`,
    (r) => r.id
  )
);

backupRoutes.get('/confidence', (c) =>
  page<{ at: number }>(
    c,
    `SELECT question_id, confidence, is_correct, at
       FROM confidence_events
      WHERE user_email = ? AND at > CAST(? AS INTEGER)
      ORDER BY at
      LIMIT ?`,
    (r) => r.at
  )
);

// 游標只走 question_id:同一題的幾則筆記(slot)一定落在同一頁,所以最後一頁
// 可能比 limit 多幾列。那比複合游標簡單,而 slot 上限是個位數。
backupRoutes.get('/notes', (c) =>
  page<{ question_id: string }>(
    c,
    `SELECT question_id, slot, content_json, created_at, updated_at
       FROM personal_notes
      WHERE user_email = ? AND question_id > ?
      ORDER BY question_id, slot
      LIMIT ?`,
    (r) => r.question_id
  )
);

backupRoutes.get('/highlights', (c) =>
  page<{ store_key: string }>(
    c,
    `SELECT store_key, content_hash, doc_json, updated_at
       FROM highlights
      WHERE user_email = ? AND store_key > ?
      ORDER BY store_key
      LIMIT ?`,
    (r) => r.store_key
  )
);

backupRoutes.get('/progress', (c) =>
  page<{ question_id: string }>(
    c,
    `SELECT question_id, times_seen, times_correct, last_seen_at, last_chosen,
            last_correct
       FROM review_progress
      WHERE user_email = ? AND question_id > ?
      ORDER BY question_id
      LIMIT ?`,
    (r) => r.question_id
  )
);

// 收藏。**不在 review_progress 裡** —— CLAUDE.md 目前寫的是
// 「`review_progress` … 也帶 `bookmarked` / `bookmark_folder_id`」,但正式機的
// 那張表沒有這兩個欄位,收藏早就搬到 bookmark_folders / bookmark_items 了。
// 照著文件寫會拿到 `no such column: bookmarked`。
backupRoutes.get('/bookmarks', (c) =>
  page<{ question_id: string }>(
    c,
    `SELECT i.question_id, i.folder_id, f.name AS folder_name, i.note, i.created_at
       FROM bookmark_items i
       LEFT JOIN bookmark_folders f ON f.id = i.folder_id
      WHERE i.user_email = ? AND i.question_id > ?
      ORDER BY i.question_id
      LIMIT ?`,
    (r) => r.question_id
  )
);

// ── 全真模擬 ────────────────────────────────────────────────────────────

backupRoutes.get('/exams', (c) =>
  page<{ id: string }>(
    c,
    `SELECT id, year, started_at, finished_at, score, duration_sec, mode
       FROM exam_sessions
      WHERE user_email = ? AND id > ?
      ORDER BY id
      LIMIT ?`,
    (r) => r.id
  )
);

// 交卷答案跟著 session 走。用 (session_id) 當游標,同一場一定不會被切開。
backupRoutes.get('/exam-answers', (c) =>
  page<{ session_id: string }>(
    c,
    `SELECT a.session_id, a.question_id, a.chosen, a.is_correct, a.answered_at
       FROM exam_answers a
       JOIN exam_sessions s ON s.id = a.session_id
      WHERE s.user_email = ? AND a.session_id > ?
      ORDER BY a.session_id, a.question_id
      LIMIT ?`,
    (r) => r.session_id
  )
);

// ── 講義:標題 + 我在第幾頁做了什麼 ─────────────────────────────────────

backupRoutes.get('/lecture-annotations', (c) =>
  page<{ id: string }>(
    c,
    `SELECT a.id, a.slug, d.title AS lecture_title, a.page, a.kind, a.payload_json,
            a.created_at, a.updated_at
       FROM lecture_annotations a
       LEFT JOIN lecture_docs d ON d.slug = a.slug
      WHERE a.user_email = ? AND a.id > ?
      ORDER BY a.id
      LIMIT ?`,
    (r) => r.id
  )
);

backupRoutes.get('/lecture-notes', (c) =>
  page<{ id: string }>(
    c,
    `SELECT n.id, n.slug, d.title AS lecture_title, n.page, n.content_json,
            n.created_at, n.updated_at
       FROM lecture_notes n
       LEFT JOIN lecture_docs d ON d.slug = n.slug
      WHERE n.user_email = ? AND n.id > ?
      ORDER BY n.id
      LIMIT ?`,
    (r) => r.id
  )
);

// ── 其他筆記(不掛題目) ────────────────────────────────────────────────

backupRoutes.get('/free-notes', (c) =>
  page<{ id: string }>(
    c,
    `SELECT id, title, content_json, created_at, updated_at
       FROM free_notes
      WHERE user_email = ? AND id > ?
      ORDER BY id
      LIMIT ?`,
    (r) => r.id
  )
);

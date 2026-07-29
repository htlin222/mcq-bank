import { Hono } from 'hono';
import type { AppContext } from '../types';

// 策展 YouTube 影片。
//
// 影片掛在主題(video_topics)上,不掛在題目上 —— 光 AML 就 91 題,
// 每題各策展一份只是把同一批影片抄 91 次。題目透過自己的 tag 命中主題:
//
//   question_tags → tag_topics → topic_videos → videos
//
// 所以之後有人幫題目補一個 tag,影片自動生效,不必重跑策展腳本。
//
// 刪除是軟刪除且全域生效:一支爛影片可能掛在多個主題下,逐主題刪只會
// 讓它在別的地方繼續冒出來。留 removed_by / removed_at 以便復原。

export const questionVideoRoutes = new Hono<AppContext>();
export const videosRoutes = new Hono<AppContext>();

type VideoRow = {
  topic_slug: string;
  topic_label: string;
  topic_kind: string;
  id: string;
  title: string;
  channel: string;
  duration_s: number;
  view_count: number;
  upload_date: string | null;
  thumb_key: string | null;
  ai_score: number | null;
  ai_reason: string | null;
  rank: number;
};

type TopicGroup = {
  slug: string;
  label: string;
  kind: string;
  videos: Omit<VideoRow, 'topic_slug' | 'topic_label' | 'topic_kind' | 'rank'>[];
};

function groupByTopic(rows: VideoRow[]): TopicGroup[] {
  const out: TopicGroup[] = [];
  const byslug = new Map<string, TopicGroup>();
  for (const r of rows) {
    let g = byslug.get(r.topic_slug);
    if (!g) {
      g = { slug: r.topic_slug, label: r.topic_label, kind: r.topic_kind, videos: [] };
      byslug.set(r.topic_slug, g);
      out.push(g);
    }
    const { topic_slug, topic_label, topic_kind, rank, ...v } = r;
    g.videos.push(v);
  }
  return out;
}

// GET /api/questions/:id/videos — 依主題分組
questionVideoRoutes.get('/:id/videos', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT vt.slug  AS topic_slug,
            vt.label AS topic_label,
            vt.kind  AS topic_kind,
            v.id, v.title, v.channel, v.duration_s, v.view_count,
            v.upload_date, v.thumb_key, v.ai_score, v.ai_reason, tv.rank
       FROM question_tags qt
       JOIN tag_topics   tt ON tt.tag = qt.tag
       JOIN video_topics vt ON vt.slug = tt.topic_slug
       JOIN topic_videos tv ON tv.topic_slug = vt.slug
       JOIN videos       v  ON v.id = tv.video_id
      WHERE qt.question_id = ? AND v.status = 'ok'
      -- 一題可能同時對到 cml 與 cml-treatment,兩組都要出現且順序穩定
      ORDER BY vt.label, tv.rank`
  )
    .bind(c.req.param('id'))
    .all<VideoRow>();

  const topics = groupByTopic(results ?? []);
  return c.json({
    topics,
    total: topics.reduce((n, t) => n + t.videos.length, 0),
  });
});

// GET /api/videos/topics — 影片庫首頁
videosRoutes.get('/topics', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT vt.slug, vt.label, vt.kind,
            COUNT(v.id) AS video_count,
            -- 每個主題挑一張縮圖當封面。rank 最小者代表這個主題。
            (SELECT v2.thumb_key
               FROM topic_videos tv2 JOIN videos v2 ON v2.id = tv2.video_id
              WHERE tv2.topic_slug = vt.slug AND v2.status = 'ok'
              ORDER BY tv2.rank LIMIT 1) AS cover_key
       FROM video_topics vt
       LEFT JOIN topic_videos tv ON tv.topic_slug = vt.slug
       LEFT JOIN videos v ON v.id = tv.video_id AND v.status = 'ok'
      GROUP BY vt.slug
      HAVING video_count > 0
      ORDER BY vt.label`
  ).all();
  return c.json({ topics: results ?? [] });
});

// GET /api/videos/topics/:slug
videosRoutes.get('/topics/:slug', async (c) => {
  const slug = c.req.param('slug');
  const topic = await c.env.DB.prepare(
    'SELECT slug, label, kind FROM video_topics WHERE slug = ?'
  )
    .bind(slug)
    .first();
  if (!topic) return c.json({ error: 'not found' }, 404);

  const { results } = await c.env.DB.prepare(
    `SELECT v.id, v.title, v.channel, v.duration_s, v.view_count,
            v.upload_date, v.thumb_key, v.ai_score, v.ai_reason
       FROM topic_videos tv JOIN videos v ON v.id = tv.video_id
      WHERE tv.topic_slug = ? AND v.status = 'ok'
      ORDER BY tv.rank`
  )
    .bind(slug)
    .all();

  return c.json({ topic, videos: results ?? [] });
});

// DELETE /api/videos/:id — 任何登入者可刪,全域生效,軟刪除
videosRoutes.delete('/:id', async (c) => {
  const id = c.req.param('id');
  const res = await c.env.DB.prepare(
    // status != 'removed' 讓重複呼叫冪等:第二次刪不會蓋掉第一個人的署名。
    `UPDATE videos SET status = 'removed', removed_by = ?, removed_at = ?
      WHERE id = ? AND status != 'removed'`
  )
    .bind(c.var.email, Date.now(), id)
    .run();

  if ((res.meta?.changes ?? 0) === 0) {
    const exists = await c.env.DB.prepare('SELECT 1 FROM videos WHERE id = ?')
      .bind(id)
      .first();
    if (!exists) return c.json({ error: 'not found' }, 404);
  }
  return c.json({ ok: true });
});

// POST /api/videos/:id/restore — 誤刪的救回來
videosRoutes.post('/:id/restore', async (c) => {
  const res = await c.env.DB.prepare(
    `UPDATE videos SET status = 'ok', removed_by = NULL, removed_at = NULL
      WHERE id = ? AND status = 'removed'`
  )
    .bind(c.req.param('id'))
    .run();
  if ((res.meta?.changes ?? 0) === 0) return c.json({ error: 'not found' }, 404);
  return c.json({ ok: true });
});

// GET /api/videos/removed — 影片庫裡的「已刪除」檢視,供復原用
videosRoutes.get('/removed', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT v.id, v.title, v.channel, v.thumb_key, v.removed_by, v.removed_at
       FROM videos v WHERE v.status = 'removed'
      ORDER BY v.removed_at DESC LIMIT 100`
  ).all();
  return c.json({ videos: results ?? [] });
});

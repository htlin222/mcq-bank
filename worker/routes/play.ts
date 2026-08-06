import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppContext } from '../types';
import { isValidState } from '../lib/play-state';

// 2048 休息小遊戲 —— 存檔在 Play2048 Durable Object (worker/play-2048.ts)。
//
// 純休息用,跟題庫完全解耦:不換步數、不跳題、不動任何學習指標。
//
// 資料流是單向的 —— 前端算完盤面 debounce 推上來,DO 從不回推;只有頁面掛載
// 時 GET 一次當初始值。

export const playRoutes = new Hono<AppContext>();

function stub(c: Context<AppContext>) {
  return c.env.PLAY.get(c.env.PLAY.idFromName('main'));
}

// 自己的存檔。沒玩過就回一個空殼,讓前端直接開新局。
playRoutes.get('/', async (c) => {
  const row = await stub(c).getGame(c.var.email);
  return c.json({
    state: row?.state ?? null,
    best: row?.best ?? 0,
    at: row?.at ?? null,
  });
});

playRoutes.put('/state', async (c) => {
  const body = await c.req.json<{ state?: unknown }>().catch(() => ({}) as const);
  const state = (body as { state?: unknown }).state;

  // 這裡不防作弊,只防資料汙染 —— 見 worker/lib/play-state.ts 的說明。
  if (!isValidState(state)) {
    return c.json({ error: 'invalid board state' }, 400);
  }

  // best 由 DO 用 MAX(舊, 新) 決定,client 送什麼都不能讓最高分變小。
  const best = await stub(c).saveGame(c.var.email, state, state.score);
  return c.json({ ok: true, best });
});

// 全員最高分。DO 只認得 email —— 顯示名稱與頭像在 D1 的 users 表,所以 join
// 在這一層做,DO 不碰 D1。
playRoutes.get('/leaderboard', async (c) => {
  const rows = await stub(c).leaderboard();
  if (rows.length === 0) return c.json([]);

  const placeholders = rows.map(() => '?').join(',');
  const { results } = await c.env.DB.prepare(
    `SELECT email, display_name, avatar_key FROM users WHERE email IN (${placeholders})`,
  )
    .bind(...rows.map((r) => r.email))
    .all<{ email: string; display_name: string; avatar_key: string | null }>();

  const byEmail = new Map(results.map((u) => [u.email, u]));

  return c.json(
    rows.map((r) => {
      const u = byEmail.get(r.email);
      return {
        email: r.email,
        // 名冊裡查不到就退回 email 的 local part —— 榜單少一個人比整條壞掉好。
        displayName: u?.display_name ?? r.email.split('@')[0],
        avatarKey: u?.avatar_key ?? null,
        best: r.best,
        at: r.at,
        me: r.email === c.var.email,
      };
    }),
  );
});

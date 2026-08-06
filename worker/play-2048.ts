import { DurableObject } from 'cloudflare:workers';
import type { Env } from './types';
import type { StoredState } from './lib/play-state';

/**
 * 2048 休息小遊戲的存檔 —— 每個人的當前棋盤與歷史最高分。
 *
 * 一個 SQLite-backed DO instance 服務所有人(idFromName("main")),跟聊天
 * 大廳、UserState 同一個免費方案友善的模式。身分由 Worker 的 Access
 * middleware 決定,DO 永遠不會收到未驗證的呼叫,所以這裡不做權限判斷。
 *
 * 為什麼不直接塞進 UserState:DO 是單執行緒的。遊戲是每步 debounce 寫入
 * (秒級),UserState 是換頁才寫一次(分鐘級)。塞在一起,等於讓某人玩遊戲時,
 * 其他人的「上次停在哪」讀取要排在遊戲寫入後面。隔離的成本只有一個 class,
 * 很便宜。
 *
 * 資料流是單向的:引擎算 → React 畫 → debounce 推這裡。這個 DO 從不回推,
 * 只在頁面掛載時被 GET 一次。
 */

export type GameRow = { state: StoredState; best: number; at: number };
export type LeaderRow = { email: string; best: number; at: number };

export class Play2048 extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS games (
        email      TEXT PRIMARY KEY,
        state      TEXT NOT NULL,
        best       INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
  }

  getGame(email: string): GameRow | null {
    const row = this.ctx.storage.sql
      .exec<{ state: string; best: number; updated_at: number }>(
        'SELECT state, best, updated_at FROM games WHERE email = ?',
        email,
      )
      .toArray()[0];
    if (!row) return null;
    try {
      return {
        state: JSON.parse(row.state) as StoredState,
        best: row.best,
        at: row.updated_at,
      };
    } catch {
      // 存進來的一定是 isValidState 過的 JSON,真的壞掉就當作沒存過,
      // 讓玩家從新局開始,而不是整頁炸掉。
      return null;
    }
  }

  /**
   * best 由這裡決定,取 MAX(舊, 新) —— client 送什麼上來都不能讓最高分變小,
   * 開新局也不會把它歸零。回傳採用後的 best。
   */
  saveGame(email: string, state: StoredState, score: number): number {
    const prev = this.ctx.storage.sql
      .exec<{ best: number }>('SELECT best FROM games WHERE email = ?', email)
      .toArray()[0];
    const best = Math.max(prev?.best ?? 0, score);

    this.ctx.storage.sql.exec(
      `INSERT INTO games (email, state, best, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(email) DO UPDATE SET
         state = excluded.state,
         best = excluded.best,
         updated_at = excluded.updated_at`,
      email,
      JSON.stringify(state),
      best,
      Date.now(),
    );
    return best;
  }

  /**
   * 全員最高分,高到低。只回 email —— 顯示名稱與頭像在 D1 的 users 表,由
   * 路由層 join 上去,這個 DO 不碰 D1。
   */
  leaderboard(limit = 50): LeaderRow[] {
    return this.ctx.storage.sql
      .exec<{ email: string; best: number; updated_at: number }>(
        `SELECT email, best, updated_at FROM games
         WHERE best > 0
         ORDER BY best DESC, updated_at ASC
         LIMIT ?`,
        limit,
      )
      .toArray()
      .map((r) => ({ email: r.email, best: r.best, at: r.updated_at }));
  }
}

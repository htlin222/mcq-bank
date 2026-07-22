// Telegram bot 的 D1 存取:綁定、設定、session、作答記錄。
// 作答走既有 review_progress + attempts 雙寫(source='review'),與網頁複習
// 同一份進度;不碰 fsrs_cards 排程(那是 anki 的另一條寫入路徑)。
import type { D1Database } from '@cloudflare/workers-types';
import { clampElapsedMs, insertAttemptOp } from './attempts.ts';

export type TgUserRow = {
  chat_id: number;
  email: string | null;
  username: string | null;
  first_name: string | null;
  subscribed: number;
  push_hour: number;
  tz_offset: number;
  year_filter: number | null;
  daily_count: number;
  last_push_on: string | null;
  created_at: number;
  updated_at: number;
};

export type SessionKind = 'daily' | 'quiz';
export type SessionData = {
  qid?: string; // 當前待答題
  remaining?: string[]; // quiz 尚未推的題 id
  score?: number;
  total?: number;
  year?: number;
};

export function getUser(db: D1Database, chatId: number): Promise<TgUserRow | null> {
  return db.prepare(`SELECT * FROM tg_users WHERE chat_id = ?`).bind(chatId).first<TgUserRow>();
}

export function getUserByEmail(db: D1Database, email: string): Promise<TgUserRow | null> {
  return db.prepare(`SELECT * FROM tg_users WHERE email = ? LIMIT 1`).bind(email).first<TgUserRow>();
}

/** 首次見到 chat 就建立列(未綁定);已存在則更新暱稱。 */
export async function ensureUser(
  db: D1Database,
  chatId: number,
  username: string | undefined,
  firstName: string | undefined,
  now: number,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO tg_users (chat_id, username, first_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(chat_id) DO UPDATE SET username = ?, first_name = ?, updated_at = ?`,
    )
    .bind(chatId, username ?? null, firstName ?? null, now, now, username ?? null, firstName ?? null, now)
    .run();
}

/** 綁定 chat 到 email(deep-link code 兌換成功後)。 */
export async function linkEmail(db: D1Database, chatId: number, email: string, now: number): Promise<void> {
  await db
    .prepare(`UPDATE tg_users SET email = ?, updated_at = ? WHERE chat_id = ?`)
    .bind(email, now, chatId)
    .run();
}

export async function unlinkChat(db: D1Database, email: string, now: number): Promise<void> {
  await db
    .prepare(`UPDATE tg_users SET email = NULL, subscribed = 0, updated_at = ? WHERE email = ?`)
    .bind(now, email)
    .run();
}

export async function updateSettings(
  db: D1Database,
  chatId: number,
  patch: Partial<Pick<TgUserRow, 'subscribed' | 'push_hour' | 'year_filter' | 'daily_count'>>,
  now: number,
): Promise<void> {
  const sets: string[] = [];
  const binds: unknown[] = [];
  for (const [k, v] of Object.entries(patch)) {
    sets.push(`${k} = ?`);
    binds.push(v);
  }
  if (!sets.length) return;
  sets.push('updated_at = ?');
  binds.push(now, chatId);
  await db.prepare(`UPDATE tg_users SET ${sets.join(', ')} WHERE chat_id = ?`).bind(...binds).run();
}

export async function markPushed(db: D1Database, chatId: number, dateStr: string, now: number): Promise<void> {
  await db
    .prepare(`UPDATE tg_users SET last_push_on = ?, updated_at = ? WHERE chat_id = ?`)
    .bind(dateStr, now, chatId)
    .run();
}

// ---- session ----

export async function getSession(
  db: D1Database,
  chatId: number,
): Promise<{ kind: SessionKind; data: SessionData } | null> {
  const row = await db
    .prepare(`SELECT kind, data_json FROM tg_sessions WHERE chat_id = ?`)
    .bind(chatId)
    .first<{ kind: SessionKind; data_json: string }>();
  if (!row) return null;
  try {
    return { kind: row.kind, data: JSON.parse(row.data_json) as SessionData };
  } catch {
    return null;
  }
}

export async function setSession(
  db: D1Database,
  chatId: number,
  kind: SessionKind,
  data: SessionData,
  now: number,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO tg_sessions (chat_id, kind, data_json, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(chat_id) DO UPDATE SET kind = ?, data_json = ?, updated_at = ?`,
    )
    .bind(chatId, kind, JSON.stringify(data), now, kind, JSON.stringify(data), now)
    .run();
}

export async function clearSession(db: D1Database, chatId: number): Promise<void> {
  await db.prepare(`DELETE FROM tg_sessions WHERE chat_id = ?`).bind(chatId).run();
}

// ---- link codes ----

export async function createLinkCode(
  db: D1Database,
  code: string,
  email: string,
  now: number,
  ttlMs: number,
): Promise<void> {
  await db
    .prepare(`INSERT INTO tg_link_codes (code, email, created_at, expires_at) VALUES (?, ?, ?, ?)`)
    .bind(code, email, now, now + ttlMs)
    .run();
}

/** 兌換綁定碼:未過期且未用過才回 email 並標記 used。否則回 null。 */
export async function consumeLinkCode(db: D1Database, code: string, now: number): Promise<string | null> {
  const row = await db
    .prepare(`SELECT email, expires_at, used_at FROM tg_link_codes WHERE code = ?`)
    .bind(code)
    .first<{ email: string; expires_at: number; used_at: number | null }>();
  if (!row || row.used_at != null || row.expires_at < now) return null;
  await db.prepare(`UPDATE tg_link_codes SET used_at = ? WHERE code = ?`).bind(now, code).run();
  return row.email;
}

// ---- 作答記錄 ----

/** 與 /api/review/answer 同一雙寫:review_progress 聚合 + attempts 事件。 */
export async function recordAnswer(
  db: D1Database,
  email: string,
  questionId: string,
  chosen: string,
  isCorrect: 0 | 1,
  now: number,
): Promise<void> {
  await db.batch([
    db
      .prepare(
        `INSERT INTO review_progress
         (user_email, question_id, times_seen, times_correct, last_seen_at, last_chosen, last_correct)
         VALUES (?, ?, 1, ?, ?, ?, ?)
         ON CONFLICT(user_email, question_id) DO UPDATE SET
           times_seen = times_seen + 1,
           times_correct = times_correct + ?,
           last_seen_at = ?,
           last_chosen = ?,
           last_correct = ?`,
      )
      .bind(email, questionId, isCorrect, now, chosen, isCorrect, isCorrect, now, chosen, isCorrect),
    insertAttemptOp({
      db,
      email,
      questionId,
      chosen,
      isCorrect,
      source: 'review',
      sessionId: null,
      elapsedMs: clampElapsedMs(null),
      now,
    }),
  ]);
}

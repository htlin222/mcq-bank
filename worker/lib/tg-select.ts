// 推題挑選:FSRS 到期 → 沒做過的新題 → 純隨機。全部只讀,不改 FSRS 排程。
import type { D1Database } from '@cloudflare/workers-types';

export type BotQuestion = {
  id: string;
  year: number;
  number: number;
  stem: string;
  options_json: string;
  answer: string;
};

const SELECT_COLS = 'id, year, number, stem, options_json, answer';

/**
 * 為某位使用者挑一題每日推播。
 *   1) FSRS 已到期(due_at <= now)且最早到期者優先
 *   2) 否則抽一題該使用者沒做過的新題(review_progress.times_seen=0 或不存在)
 *   3) 都沒有才純隨機
 * yearFilter 為 null 時不限年份。無任何題目回 null。
 */
export async function pickDailyQuestion(
  db: D1Database,
  email: string,
  yearFilter: number | null,
  now: number,
): Promise<BotQuestion | null> {
  const yearCond = yearFilter != null ? 'AND q.year = ?' : '';
  const yearBind = yearFilter != null ? [yearFilter] : [];

  // 1) 到期題
  const due = await db
    .prepare(
      `SELECT ${SELECT_COLS.split(', ').map((c) => `q.${c}`).join(', ')}
       FROM fsrs_cards fc JOIN questions q ON q.id = fc.question_id
       WHERE fc.user_email = ? AND fc.due_at <= ? ${yearCond}
       ORDER BY fc.due_at ASC LIMIT 1`,
    )
    .bind(email, now, ...yearBind)
    .first<BotQuestion>();
  if (due) return due;

  // 2) 沒做過的新題
  const fresh = await db
    .prepare(
      `SELECT ${SELECT_COLS} FROM questions q
       WHERE 1=1 ${yearCond}
         AND q.id NOT IN (
           SELECT question_id FROM review_progress
           WHERE user_email = ? AND times_seen > 0
         )
       ORDER BY RANDOM() LIMIT 1`,
    )
    .bind(...yearBind, email)
    .first<BotQuestion>();
  if (fresh) return fresh;

  // 3) 純隨機
  return await db
    .prepare(`SELECT ${SELECT_COLS} FROM questions q WHERE 1=1 ${yearCond} ORDER BY RANDOM() LIMIT 1`)
    .bind(...yearBind)
    .first<BotQuestion>();
}

/** 抽某年 N 題(隨機順序)給小測驗,回題目 id 陣列。 */
export async function pickQuizIds(
  db: D1Database,
  year: number,
  count: number,
): Promise<string[]> {
  const { results } = await db
    .prepare(`SELECT id FROM questions WHERE year = ? ORDER BY RANDOM() LIMIT ?`)
    .bind(year, count)
    .all<{ id: string }>();
  return (results ?? []).map((r) => r.id);
}

/** 依 id 取單題(小測驗逐題推進時用)。 */
export function getQuestion(db: D1Database, id: string): Promise<BotQuestion | null> {
  return db
    .prepare(`SELECT ${SELECT_COLS} FROM questions WHERE id = ?`)
    .bind(id)
    .first<BotQuestion>();
}

/** 該使用者有題目的年份清單(降冪),供 /quiz 選單。 */
export async function listYears(db: D1Database): Promise<number[]> {
  const { results } = await db
    .prepare(`SELECT DISTINCT year FROM questions ORDER BY year DESC`)
    .all<{ year: number }>();
  return (results ?? []).map((r) => r.year);
}

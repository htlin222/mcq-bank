// Cron 每小時 tick:對每位訂閱且已綁定的使用者,若其本地時 == push_hour 且
// 今天還沒推過,就送一題。單次 tick 上限 MAX_PER_TICK 以防爆量。
import type { Env } from '../types.ts';
import type { TgUserRow } from './tg-store.ts';
import { markPushed, setSession } from './tg-store.ts';
import { pickDailyQuestion } from './tg-select.ts';
import { buildAnswerKeyboard, formatQuestion, parseOptions, sendMessage } from './telegram.ts';
import { localParts } from './telegram.ts';

const MAX_PER_TICK = 50;

export type PushResult = { candidates: number; pushed: number; errors: number };

export async function runPushTick(env: Env, now: number): Promise<PushResult> {
  const token = env.TG_BOT_TOKEN;
  if (!token) return { candidates: 0, pushed: 0, errors: 0 };

  const { results } = await env.DB.prepare(
    `SELECT * FROM tg_users WHERE subscribed = 1 AND email IS NOT NULL`,
  ).all<TgUserRow>();
  const rows = results ?? [];

  let pushed = 0;
  let errors = 0;
  let candidates = 0;

  for (const u of rows) {
    const { hour, dateStr } = localParts(now, u.tz_offset);
    if (hour !== u.push_hour) continue; // 未到本地推播時段
    if (u.last_push_on === dateStr) continue; // 今天已推過
    candidates++;
    if (pushed >= MAX_PER_TICK) break;

    try {
      const q = await pickDailyQuestion(env.DB, u.email!, u.year_filter, now);
      if (!q) {
        // 沒題可推也算今天處理過,免得整點反覆試。
        await markPushed(env.DB, u.chat_id, dateStr, now);
        continue;
      }
      await sendMessage(
        token,
        u.chat_id,
        formatQuestion(q, '📮 每日一題'),
        buildAnswerKeyboard(q.id, parseOptions(q.options_json)),
      );
      await setSession(env.DB, u.chat_id, 'daily', { qid: q.id }, now);
      await markPushed(env.DB, u.chat_id, dateStr, now);
      pushed++;
    } catch (e) {
      errors++;
      console.error('[tg push] failed for', u.chat_id, e);
    }
  }

  return { candidates, pushed, errors };
}

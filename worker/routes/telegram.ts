// Telegram 出題機器人的兩組路由:
//   webhookRoutes      — 公開,掛在 /tg(不在 /api/* 下,不吃 Access middleware)
//   telegramApiRoutes  — 走 Access,掛在 /api/telegram(app 內綁定/狀態)
//
// 設計見 docs/plans/2026-07-22-telegram-bot-design.md。
import { Hono } from 'hono';
import type { AppContext, Env } from '../types.ts';
import {
  answerCallbackQuery,
  appendExplanation,
  buildAnswerKeyboard,
  editMessageText,
  formatQuestion,
  formatReveal,
  parseCallback,
  parseOptions,
  sendMessage,
  timingSafeEqual,
  type InlineButton,
  type InlineKeyboard,
  type TgUpdate,
} from '../lib/telegram.ts';
import {
  clearSession,
  consumeLinkCode,
  createLinkCode,
  ensureUser,
  getExplanationText,
  getSession,
  getUser,
  getUserByEmail,
  linkEmail,
  markPushed,
  recordAnswer,
  setSession,
  unlinkChat,
  updateSettings,
  type TgUserRow,
} from '../lib/tg-store.ts';
import { getQuestion, listYears, pickDailyQuestion, pickQuizIds } from '../lib/tg-select.ts';

const LINK_TTL_MS = 15 * 60_000;

// ============ 公開 webhook ============

export const webhookRoutes = new Hono<AppContext>();

webhookRoutes.post('/webhook', async (c) => {
  const token = c.env.TG_BOT_TOKEN;
  const secret = c.env.TG_WEBHOOK_SECRET;
  // 未設定 → 靜默 200,避免 Telegram 端不斷重送。
  if (!token || !secret) return c.json({ ok: true });

  const got = c.req.header('X-Telegram-Bot-Api-Secret-Token') ?? '';
  if (!timingSafeEqual(got, secret)) return c.json({ error: 'unauthorized' }, 401);

  let update: TgUpdate;
  try {
    update = await c.req.json<TgUpdate>();
  } catch {
    return c.json({ ok: true }); // 壞 payload 直接吞掉
  }

  // 任何處理錯誤都吞下並回 200 —— 回非 2xx 會讓 Telegram 重送造成重複。
  try {
    await handleUpdate(c.env, token, update);
  } catch (e) {
    console.error('[tg webhook] handler error', e);
  }
  return c.json({ ok: true });
});

// ============ 分派 ============

async function handleUpdate(env: Env, token: string, u: TgUpdate): Promise<void> {
  if (u.message?.text) return handleMessage(env, token, u);
  if (u.callback_query) return handleCallback(env, token, u);
}

async function handleMessage(env: Env, token: string, u: TgUpdate): Promise<void> {
  const msg = u.message!;
  const chatId = msg.chat.id;
  const now = Date.now();
  await ensureUser(env.DB, chatId, msg.from?.username, msg.from?.first_name, now);

  const text = (msg.text ?? '').trim();

  if (text.startsWith('/start')) {
    const code = text.split(/\s+/)[1];
    if (code) {
      const email = await consumeLinkCode(env.DB, code, now);
      if (!email) {
        await sendMessage(token, chatId, '這個綁定連結無效或已過期。請回 app 重新產生一次。');
        return;
      }
      await linkEmail(env.DB, chatId, email, now);
      await sendMessage(
        token,
        chatId,
        `綁定成功 ✅\n你的帳號 <b>${escapeAngle(email)}</b> 已連結。\n\n` +
          '之後每天會在你設定的時段收到一題。指令:\n' +
          '/today 立刻來一題 · /quiz 開始測驗 · /stats 我的統計 · /settings 設定',
      );
      return;
    }
    await sendMessage(
      token,
      chatId,
      '歡迎使用血液腫瘤考古題機器人 👋\n\n' +
        '請先到 app 的「個人」頁 → Telegram 推播 → 產生連結,點該連結即可綁定你的帳號。\n' +
        '綁定後就能收到每日一題,也能用 /quiz 開始測驗。',
    );
    return;
  }

  const user = await getUser(env.DB, chatId);
  const linked = !!user?.email;

  if (text.startsWith('/help')) {
    await sendMessage(token, chatId, HELP_TEXT);
    return;
  }
  if (!linked) {
    await sendMessage(token, chatId, '你還沒綁定帳號。請到 app「個人」頁產生連結後點開,或送 /help。');
    return;
  }

  if (text.startsWith('/today')) return pushDaily(env, token, chatId, user!, now);
  if (text.startsWith('/quiz')) return sendYearPicker(env, token, chatId);
  if (text.startsWith('/stats')) return sendStats(env, token, chatId, user!.email!);
  if (text.startsWith('/settings')) return sendSettings(env, token, chatId, user!);
  if (text.startsWith('/stop')) {
    await updateSettings(env.DB, chatId, { subscribed: 0 }, now);
    await sendMessage(token, chatId, '已暫停每日推播。要恢復用 /settings。');
    return;
  }
  await sendMessage(token, chatId, '看不懂這個指令。送 /help 看可用指令。');
}

async function handleCallback(env: Env, token: string, u: TgUpdate): Promise<void> {
  const cq = u.callback_query!;
  const chatId = cq.message?.chat.id;
  const messageId = cq.message?.message_id;
  const now = Date.now();
  const cb = parseCallback(cq.data);

  if (!chatId || !messageId || !cb) {
    await answerCallbackQuery(token, cq.id);
    return;
  }

  const user = await getUser(env.DB, chatId);
  if (!user?.email) {
    await answerCallbackQuery(token, cq.id, '請先綁定帳號');
    return;
  }
  const email = user.email;

  switch (cb.kind) {
    case 'answer': {
      const q = await getQuestion(env.DB, cb.qid);
      if (!q) {
        await answerCallbackQuery(token, cq.id, '找不到題目');
        return;
      }
      const isCorrect: 0 | 1 = q.answer === cb.key ? 1 : 0;
      await recordAnswer(env.DB, email, q.id, cb.key, isCorrect, now);
      await answerCallbackQuery(token, cq.id, isCorrect ? '答對了 🎉' : '答錯了');

      // 答對/答錯都揭曉詳解;測驗模式會自動推進,其餘模式給「下一題」按鈕。
      const sess = await getSession(env.DB, chatId);
      const inQuiz = sess?.kind === 'quiz' && sess.data.qid === q.id;
      const expl = await getExplanationText(env.DB, q.id);
      const revealText = appendExplanation(formatReveal(q, cb.key, q.answer), expl);
      await editMessageText(token, chatId, messageId, revealText, revealKeyboard(env, q.id, !inQuiz));

      if (inQuiz) {
        const score = (sess.data.score ?? 0) + isCorrect;
        const remaining = sess.data.remaining ?? [];
        const total = sess.data.total ?? 0;
        const nextId = remaining.shift();
        if (nextId) {
          const nq = await getQuestion(env.DB, nextId);
          if (nq) {
            const idx = total - remaining.length;
            await sendMessage(
              token,
              chatId,
              formatQuestion(nq, `📝 測驗 ${idx}/${total}`),
              buildAnswerKeyboard(nq.id, parseOptions(nq.options_json)),
            );
            await setSession(env.DB, chatId, 'quiz', { qid: nq.id, remaining, score, total, year: sess.data.year }, now);
            return;
          }
        }
        await clearSession(env.DB, chatId);
        await sendMessage(token, chatId, `測驗結束 🏁\n得分 <b>${score}/${total}</b>`);
      } else if (sess?.kind === 'daily') {
        await clearSession(env.DB, chatId);
      }
      return;
    }
    case 'quiz-year': {
      await setSession(env.DB, chatId, 'quiz', { year: cb.year }, now);
      await answerCallbackQuery(token, cq.id);
      await editMessageText(token, chatId, messageId, `已選 <b>${cb.year}</b> 年,要幾題?`, countKeyboard());
      return;
    }
    case 'quiz-count': {
      const sess = await getSession(env.DB, chatId);
      const year = sess?.data.year;
      await answerCallbackQuery(token, cq.id);
      if (!year) {
        await editMessageText(token, chatId, messageId, '請重新用 /quiz 選年份。');
        return;
      }
      const ids = await pickQuizIds(env.DB, year, cb.count);
      if (!ids.length) {
        await editMessageText(token, chatId, messageId, `${year} 年沒有題目。`);
        await clearSession(env.DB, chatId);
        return;
      }
      const total = ids.length;
      const firstId = ids.shift()!;
      const q = await getQuestion(env.DB, firstId);
      await editMessageText(token, chatId, messageId, `開始 ${year} 年測驗,共 ${total} 題。加油!`);
      if (q) {
        await sendMessage(
          token,
          chatId,
          formatQuestion(q, `📝 測驗 1/${total}`),
          buildAnswerKeyboard(q.id, parseOptions(q.options_json)),
        );
        await setSession(env.DB, chatId, 'quiz', { qid: q.id, remaining: ids, score: 0, total, year }, now);
      }
      return;
    }
    case 'set-sub': {
      await updateSettings(env.DB, chatId, { subscribed: cb.on ? 1 : 0 }, now);
      await answerCallbackQuery(token, cq.id, cb.on ? '已開啟' : '已關閉');
      await renderSettings(env, token, chatId, messageId);
      return;
    }
    case 'set-hour': {
      await updateSettings(env.DB, chatId, { push_hour: cb.hour }, now);
      await answerCallbackQuery(token, cq.id, `推播時段設為 ${cb.hour}:00`);
      await renderSettings(env, token, chatId, messageId);
      return;
    }
    case 'set-year': {
      await updateSettings(env.DB, chatId, { year_filter: cb.year }, now);
      await answerCallbackQuery(token, cq.id);
      await renderSettings(env, token, chatId, messageId);
      return;
    }
    case 'nav': {
      await answerCallbackQuery(token, cq.id);
      if (cb.to === 'today') return pushDaily(env, token, chatId, user, now);
      if (cb.to === 'quiz') return sendYearPicker(env, token, chatId);
      return;
    }
    default:
      await answerCallbackQuery(token, cq.id);
  }
}

// ============ 動作 ============

async function pushDaily(env: Env, token: string, chatId: number, user: TgUserRow, now: number): Promise<void> {
  const q = await pickDailyQuestion(env.DB, user.email!, user.year_filter, now);
  if (!q) {
    await sendMessage(token, chatId, '目前沒有可出的題目。');
    return;
  }
  await sendMessage(token, chatId, formatQuestion(q, '📮 一題'), buildAnswerKeyboard(q.id, parseOptions(q.options_json)));
  await setSession(env.DB, chatId, 'daily', { qid: q.id }, now);
  await markPushed(env.DB, chatId, localDate(now, user.tz_offset), now);
}

async function sendYearPicker(env: Env, token: string, chatId: number): Promise<void> {
  const years = await listYears(env.DB);
  if (!years.length) {
    await sendMessage(token, chatId, '題庫還沒有題目。');
    return;
  }
  await sendMessage(token, chatId, '要考哪一年?', yearKeyboard(years, 'quiz:year:'));
}

async function sendStats(env: Env, token: string, chatId: number, email: string): Promise<void> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n, COALESCE(SUM(times_correct),0) AS c, COALESCE(SUM(times_seen),0) AS t
     FROM review_progress WHERE user_email = ? AND times_seen > 0`,
  )
    .bind(email)
    .first<{ n: number; c: number; t: number }>();
  const n = row?.n ?? 0;
  const c = row?.c ?? 0;
  const t = row?.t ?? 0;
  const pct = t > 0 ? Math.round((c / t) * 100) : 0;
  await sendMessage(
    token,
    chatId,
    `📊 你的統計\n做過題數: <b>${n}</b>\n總作答: ${t} 次\n正確率: <b>${pct}%</b>`,
  );
}

async function sendSettings(env: Env, token: string, chatId: number, user: TgUserRow): Promise<void> {
  await sendMessage(token, chatId, settingsText(user), await settingsKeyboard(env, user));
}

/** 就地重繪設定訊息(toggle 後)。 */
async function renderSettings(env: Env, token: string, chatId: number, messageId: number): Promise<void> {
  const user = await getUser(env.DB, chatId);
  if (!user) return;
  await editMessageText(token, chatId, messageId, settingsText(user), await settingsKeyboard(env, user));
}

// ============ 視圖 ============

const HELP_TEXT =
  '可用指令:\n' +
  '/today — 立刻來一題\n' +
  '/quiz — 挑年份開始測驗\n' +
  '/stats — 我的統計\n' +
  '/settings — 推播時段 / 年份 / 開關\n' +
  '/stop — 暫停每日推播\n' +
  '/help — 這則說明';

function settingsText(u: TgUserRow): string {
  const year = u.year_filter == null ? '全部' : String(u.year_filter);
  return (
    '⚙️ 設定\n' +
    `每日推播: <b>${u.subscribed ? '開' : '關'}</b>\n` +
    `推播時段: <b>${u.push_hour}:00</b>\n` +
    `出題年份: <b>${year}</b>`
  );
}

async function settingsKeyboard(env: Env, u: TgUserRow): Promise<InlineKeyboard> {
  const hours = [7, 8, 9, 12, 21];
  const years = await listYears(env.DB);
  const rows = [];
  rows.push([
    { text: u.subscribed ? '🔔 每日推播:開' : '🔕 每日推播:關', callback_data: `set:sub:${u.subscribed ? 0 : 1}` },
  ]);
  rows.push(
    hours.map((h) => ({ text: `${u.push_hour === h ? '•' : ''}${h}:00`, callback_data: `set:hour:${h}` })),
  );
  rows.push([{ text: `${u.year_filter == null ? '•' : ''}全部年份`, callback_data: 'set:year:all' }]);
  for (let i = 0; i < years.length; i += 4) {
    rows.push(
      years.slice(i, i + 4).map((y) => ({
        text: `${u.year_filter === y ? '•' : ''}${y}`,
        callback_data: `set:year:${y}`,
      })),
    );
  }
  return { inline_keyboard: rows };
}

function yearKeyboard(years: number[], prefix: string): InlineKeyboard {
  const rows = [];
  for (let i = 0; i < years.length; i += 4) {
    rows.push(years.slice(i, i + 4).map((y) => ({ text: String(y), callback_data: `${prefix}${y}` })));
  }
  return { inline_keyboard: rows };
}

function countKeyboard(): InlineKeyboard {
  return {
    inline_keyboard: [[10, 20, 50].map((n) => ({ text: `${n} 題`, callback_data: `quiz:count:${n}` }))],
  };
}

/**
 * 揭曉後的鍵盤:一列「看詳解 / 討論」連回 app(PUBLIC_HOST 有設時),
 * withNext 時再加一列「下一題 ▶」(callback nav:today)。兩者皆無則回 undefined。
 */
function revealKeyboard(env: Env, qid: string, withNext: boolean): InlineKeyboard | undefined {
  const rows: InlineButton[][] = [];
  if (env.PUBLIC_HOST) {
    rows.push([{ text: '看詳解 / 討論', url: `https://${env.PUBLIC_HOST}/q/${qid}` }]);
  }
  if (withNext) {
    rows.push([{ text: '下一題 ▶', callback_data: 'nav:today' }]);
  }
  return rows.length ? { inline_keyboard: rows } : undefined;
}

function localDate(now: number, tzOffsetMin: number): string {
  const d = new Date(now + tzOffsetMin * 60_000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function escapeAngle(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ============ app 內 API(走 Access) ============

export const telegramApiRoutes = new Hono<AppContext>();

// 綁定狀態
telegramApiRoutes.get('/status', async (c) => {
  const email = c.var.email;
  const row = await getUserByEmail(c.env.DB, email);
  const configured = !!(c.env.TG_BOT_TOKEN && c.env.TG_BOT_USERNAME);
  return c.json({
    configured,
    bot_username: c.env.TG_BOT_USERNAME ?? null,
    linked: !!row,
    subscribed: row ? !!row.subscribed : false,
    username: row?.username ?? null,
  });
});

// 產生一次性綁定碼 + deep link
telegramApiRoutes.post('/link-code', async (c) => {
  if (!c.env.TG_BOT_TOKEN || !c.env.TG_BOT_USERNAME) {
    return c.json({ error: 'telegram not configured' }, 501);
  }
  const email = c.var.email;
  const now = Date.now();
  const code = genCode();
  await createLinkCode(c.env.DB, code, email, now, LINK_TTL_MS);
  return c.json({
    code,
    deep_link: `https://t.me/${c.env.TG_BOT_USERNAME}?start=${code}`,
    expires_in_sec: LINK_TTL_MS / 1000,
  });
});

// 解除綁定
telegramApiRoutes.post('/unlink', async (c) => {
  await unlinkChat(c.env.DB, c.var.email, Date.now());
  return c.json({ ok: true });
});

/** 16 字 base32(RFC4648 字元集,皆合法 deep-link payload)。 */
function genCode(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += alphabet[b % 32];
  return out;
}

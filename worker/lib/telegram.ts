// Telegram Bot API 薄封裝 + 純函式(可單元測試)。
//
// 設計取捨見 docs/plans/2026-07-22-telegram-bot-design.md:
//   - parse_mode 一律 HTML(只需跳脫 & < >)
//   - callback_data 短前綴,確保 ≤ 64 bytes
//   - webhook secret 以常數時間比對

// ============ 型別(僅取用到的欄位) ============

export type TgUser = {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  username?: string;
};

export type TgChat = { id: number; type?: string };

export type TgMessage = {
  message_id: number;
  from?: TgUser;
  chat: TgChat;
  text?: string;
};

export type TgCallbackQuery = {
  id: string;
  from: TgUser;
  message?: TgMessage;
  data?: string;
};

export type TgUpdate = {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallbackQuery;
};

export type InlineButton = {
  text: string;
  callback_data?: string;
  url?: string;
};
export type InlineKeyboard = { inline_keyboard: InlineButton[][] };

export type QuestionOption = { key: string; text: string };

// ============ 純函式 ============

/** HTML parse_mode 只需跳脫這三個字元。 */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 常數時間字串比對 —— 防 webhook secret 的時序側信道。長度不同直接 false。 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** 解析 questions.options_json;壞資料回空陣列而非丟例外。 */
export function parseOptions(optionsJson: string): QuestionOption[] {
  try {
    const arr = JSON.parse(optionsJson);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((o) => o && typeof o.key === 'string' && typeof o.text === 'string')
      .map((o) => ({ key: o.key, text: o.text }));
  } catch {
    return [];
  }
}

export type Callback =
  | { kind: 'answer'; qid: string; key: string }
  | { kind: 'quiz-year'; year: number }
  | { kind: 'quiz-count'; count: number }
  | { kind: 'set-sub'; on: boolean }
  | { kind: 'set-hour'; hour: number }
  | { kind: 'set-year'; year: number | null }
  | { kind: 'nav'; to: string }
  | { kind: 'noop' }
  | null;

/**
 * 解析 callback_data。格式為冒號分段的短前綴:
 *   ans:<qid>:<key>   quiz:year:<y>   quiz:count:<n>
 *   set:sub:<0|1>     set:hour:<h>    set:year:<y|all>
 *   nav:<dest>        noop
 * 無法辨識回 null。
 */
export function parseCallback(data: string | undefined): Callback {
  if (!data) return null;
  const p = data.split(':');
  switch (p[0]) {
    case 'ans':
      // qid 本身不含冒號(格式 "2024-001"),但保險起見取首尾。
      if (p.length >= 3 && p[1] && p[2]) return { kind: 'answer', qid: p[1], key: p[2] };
      return null;
    case 'quiz':
      if (p[1] === 'year' && isYear(p[2])) return { kind: 'quiz-year', year: Number(p[2]) };
      if (p[1] === 'count' && isPosInt(p[2])) return { kind: 'quiz-count', count: Number(p[2]) };
      return null;
    case 'set':
      if (p[1] === 'sub' && (p[2] === '0' || p[2] === '1'))
        return { kind: 'set-sub', on: p[2] === '1' };
      if (p[1] === 'hour' && isHour(p[2])) return { kind: 'set-hour', hour: Number(p[2]) };
      if (p[1] === 'year')
        return { kind: 'set-year', year: p[2] === 'all' ? null : isYear(p[2]) ? Number(p[2]) : null };
      return null;
    case 'nav':
      return p[1] ? { kind: 'nav', to: p[1] } : null;
    case 'noop':
      return { kind: 'noop' };
    default:
      return null;
  }
}

// 接受 3–4 位數年份 —— 這個 fork 用民國年(104–114),其他 fork 可能用西元年。
function isYear(s: string | undefined): boolean {
  return !!s && /^\d{3,4}$/.test(s);
}
function isHour(s: string | undefined): boolean {
  if (!s || !/^\d{1,2}$/.test(s)) return false;
  const n = Number(s);
  return n >= 0 && n <= 23;
}
function isPosInt(s: string | undefined): boolean {
  return !!s && /^\d{1,3}$/.test(s) && Number(s) > 0;
}

/**
 * 作答用的選項鍵盤:一列一顆(單欄),按鈕文字直接包完整選項「(A) 內容」,
 * 點按鈕即作答,不必再回題幹對照字母。按鈕文字是純文字(非 HTML),不需跳脫。
 * callback_data = ans:<qid>:<key>(僅字母,≤ 64 bytes)。
 */
export function buildAnswerKeyboard(qid: string, options: QuestionOption[]): InlineKeyboard {
  return {
    inline_keyboard: options.map((o) => [
      { text: `(${o.key}) ${o.text}`, callback_data: `ans:${qid}:${o.key}` },
    ]),
  };
}

export type QuestionForBot = {
  id: string;
  year: number;
  number: number;
  stem: string;
  options_json: string;
};

/**
 * 題幹的 HTML 文字(答題前,不含正解)。題號粗體、題幹用 <blockquote> 縮排成塊。
 * 選項不列在文字裡 —— 由 buildAnswerKeyboard 以單欄整段按鈕呈現,避免重複。
 */
export function formatQuestion(q: QuestionForBot, header?: string): string {
  const lines: string[] = [];
  if (header) lines.push(`<b>${escapeHtml(header)}</b>`);
  lines.push(`<b>${escapeHtml(String(q.year))}-${String(q.number).padStart(3, '0')}</b>`);
  lines.push('');
  lines.push(`<blockquote>${escapeHtml(q.stem)}</blockquote>`);
  return lines.join('\n');
}

/** 揭曉文字:標出使用者的選擇對錯與正解。 */
export function formatReveal(
  q: QuestionForBot,
  chosen: string,
  answer: string,
): string {
  const opts = parseOptions(q.options_json);
  const correct = chosen === answer;
  const lines: string[] = [];
  lines.push(`<b>${escapeHtml(String(q.year))}-${String(q.number).padStart(3, '0')}</b>`);
  lines.push('');
  lines.push(`<blockquote>${escapeHtml(q.stem)}</blockquote>`);
  lines.push('');
  for (const o of opts) {
    const mark = o.key === answer ? '✅' : o.key === chosen ? '❌' : '▫️';
    lines.push(`${mark} <b>${escapeHtml(o.key)}.</b> ${escapeHtml(o.text)}`);
  }
  lines.push('');
  lines.push(correct ? '答對了 🎉' : `答錯 —— 正解是 <b>${escapeHtml(answer)}</b>`);
  return lines.join('\n');
}

const BLOCK_TYPES = new Set(['paragraph', 'heading', 'blockquote', 'codeBlock', 'listItem']);

/**
 * TipTap / ProseMirror JSON → 純文字。詳解存的是 TipTap JSON,Telegram 只吃
 * 純文字/基本 HTML,故走訪節點抽 text:區塊結尾補換行、清單項前加「• 」、
 * 圖片以［圖片］佔位。壞資料回空字串而非丟例外。
 */
export function tiptapToText(doc: unknown): string {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    const n = node as { type?: string; text?: string; content?: unknown[] };
    if (n.type === 'text' && typeof n.text === 'string') {
      out.push(n.text);
      return;
    }
    if (n.type === 'hardBreak') {
      out.push('\n');
      return;
    }
    if (n.type === 'image') {
      out.push('［圖片］');
      return;
    }
    if (n.type === 'listItem') out.push('• ');
    if (Array.isArray(n.content)) n.content.forEach(walk);
    if (n.type && BLOCK_TYPES.has(n.type)) out.push('\n');
  };
  walk(doc);
  return out.join('').replace(/\n{3,}/g, '\n\n').trim();
}

/** Telegram sendMessage/editMessageText 單則文字上限。 */
export const TG_TEXT_LIMIT = 4096;

/**
 * 把詳解接在揭曉文字之後,依 Telegram 4096 上限截斷(HTML 跳脫後計)。
 * 詳解為空、或剩餘空間放不下有意義片段時,直接回原揭曉文字(靠按鈕看全文)。
 */
export function appendExplanation(reveal: string, explanation: string): string {
  const body = explanation.trim();
  if (!body) return reveal;
  const header = '\n\n📖 詳解\n';
  const budget = TG_TEXT_LIMIT - reveal.length - header.length - 40;
  const cap = Math.min(1200, budget);
  if (cap < 80) return reveal;
  const truncated = body.length > cap;
  const shown = escapeHtml(body.slice(0, cap)) + (truncated ? '…' : '');
  return reveal + header + shown + (truncated ? '\n（點下方看全文）' : '');
}

/**
 * 由 UTC 毫秒 + 時區偏移(分鐘,UTC 以東為正)算出本地「時」與「YYYY-MM-DD」。
 * 用 getUTC* 於平移後的時間戳,避免依賴執行環境時區。
 */
export function localParts(nowMs: number, tzOffsetMin: number): { hour: number; dateStr: string } {
  const d = new Date(nowMs + tzOffsetMin * 60_000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return { hour: d.getUTCHours(), dateStr: `${y}-${m}-${day}` };
}

// ============ Bot API I/O ============

const API = 'https://api.telegram.org';

/** 呼叫一個 Bot API method。回傳 result 或丟含描述的例外。 */
export async function tgCall<T = unknown>(
  token: string,
  method: string,
  params: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(`${API}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params),
  });
  const json = (await res.json()) as { ok: boolean; result?: T; description?: string };
  if (!json.ok) throw new Error(`telegram ${method} failed: ${json.description ?? res.status}`);
  return json.result as T;
}

export function sendMessage(
  token: string,
  chatId: number,
  text: string,
  keyboard?: InlineKeyboard,
) {
  return tgCall(token, 'sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...(keyboard ? { reply_markup: keyboard } : {}),
  });
}

export function editMessageText(
  token: string,
  chatId: number,
  messageId: number,
  text: string,
  keyboard?: InlineKeyboard,
) {
  return tgCall(token, 'editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...(keyboard ? { reply_markup: keyboard } : { reply_markup: { inline_keyboard: [] } }),
  });
}

export function answerCallbackQuery(token: string, id: string, text?: string) {
  return tgCall(token, 'answerCallbackQuery', {
    callback_query_id: id,
    ...(text ? { text } : {}),
  });
}

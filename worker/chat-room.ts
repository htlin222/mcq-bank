import { DurableObject } from 'cloudflare:workers';
import type { Env } from './types';

/**
 * 聊天大廳 — one shared room (idFromName("lobby")) over the WebSocket
 * Hibernation API, so idle connections cost nothing and the DO sleeps
 * between messages (free-plan friendly).
 *
 * Messages live in the DO's own SQLite storage, trimmed to the last
 * MAX_MESSAGES. D1 is only touched when a message @mentions someone who
 * is NOT currently connected — those get a `notifications` row
 * (kind='chat_mention') so the bell picks it up on their next visit.
 *
 * Identity is verified by the Worker's Access middleware BEFORE the
 * upgrade is forwarded here (X-Chat-Email / X-Chat-Name headers, URI-
 * encoded because headers are ByteStrings). The DO never sees an
 * unauthenticated socket.
 */

type Attachment = { email: string; name: string };

type MessageRow = {
  id: number;
  email: string;
  name: string;
  text: string;
  mentions: string;      // JSON array of emails
  mention_all: number;   // 0 | 1
  reply_to: number | null;
  reply_name: string | null;
  reply_snippet: string | null;
  created_at: number;
};

type ReactionRow = { message_id: number; emoji: string; email: string };

const MAX_MESSAGES = 500;
const MAX_TEXT_LEN = 2000;
const MAX_MENTIONS = 25;
const PAGE_SIZE = 50;
const REPLY_SNIPPET_LEN = 80;
const PREVIEW_LEN = 120;

// Fixed reaction palette — anything else is rejected server-side.
export const CHAT_EMOJI = ['👍', '❤️', '😂', '😮', '🙏', '🔥', '🎉'];

export class ChatRoom extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        email         TEXT NOT NULL,
        name          TEXT NOT NULL,
        text          TEXT NOT NULL,
        mentions      TEXT NOT NULL DEFAULT '[]',
        mention_all   INTEGER NOT NULL DEFAULT 0,
        reply_to      INTEGER,
        reply_name    TEXT,
        reply_snippet TEXT,
        created_at    INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS reactions (
        message_id  INTEGER NOT NULL,
        email       TEXT NOT NULL,
        emoji       TEXT NOT NULL,
        created_at  INTEGER NOT NULL,
        PRIMARY KEY (message_id, email, emoji)
      );
    `);
    // Keepalive pings answered without waking the DO out of hibernation.
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair('ping', 'pong'),
    );
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('expected websocket', { status: 426 });
    }
    const email = decodeURIComponent(request.headers.get('X-Chat-Email') ?? '');
    const name = decodeURIComponent(request.headers.get('X-Chat-Name') ?? '');
    if (!email) return new Response('missing identity', { status: 400 });

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ email, name: name || email.split('@')[0] });

    server.send(
      JSON.stringify({
        type: 'init',
        messages: this.recentMessages(),
        reactions: this.reactionsFor(this.recentMessages().map((m) => m.id)),
        online: this.onlineUsers(),
      }),
    );
    this.broadcastOnline();

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: ArrayBuffer | string) {
    if (typeof raw !== 'string' || raw.length > MAX_TEXT_LEN * 4) return;
    const who = ws.deserializeAttachment() as Attachment | null;
    if (!who) return;

    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    try {
      switch (msg?.type) {
        case 'send':
          await this.handleSend(who, msg);
          break;
        case 'react':
          this.handleReact(who, msg);
          break;
        case 'history':
          this.handleHistory(ws, msg);
          break;
      }
    } catch (err) {
      console.error('[chat] message failed', String(err));
      try {
        ws.send(JSON.stringify({ type: 'error', message: '訊息處理失敗' }));
      } catch {
        /* socket already gone */
      }
    }
  }

  webSocketClose(_ws: WebSocket) {
    this.broadcastOnline();
  }

  webSocketError(_ws: WebSocket) {
    this.broadcastOnline();
  }

  // ===== handlers ==========================================================

  private async handleSend(
    who: Attachment,
    msg: { text?: unknown; mentions?: unknown; mentionAll?: unknown; replyTo?: unknown },
  ) {
    const text = typeof msg.text === 'string' ? msg.text.trim() : '';
    if (!text || text.length > MAX_TEXT_LEN) return;

    const mentionAll = msg.mentionAll === true;
    const rawMentions = Array.isArray(msg.mentions)
      ? msg.mentions.filter((m): m is string => typeof m === 'string').slice(0, MAX_MENTIONS)
      : [];
    // Only emails that actually exist in the roster count as mentions.
    const mentions = await this.validEmails(rawMentions);

    // Reply snapshot — survives even after the quoted message is trimmed.
    let replyTo: number | null = null;
    let replyName: string | null = null;
    let replySnippet: string | null = null;
    if (typeof msg.replyTo === 'number' && Number.isInteger(msg.replyTo)) {
      const quoted = this.ctx.storage.sql
        .exec<MessageRow>('SELECT * FROM messages WHERE id = ?', msg.replyTo)
        .toArray()[0];
      if (quoted) {
        replyTo = quoted.id;
        replyName = quoted.name;
        replySnippet =
          quoted.text.length > REPLY_SNIPPET_LEN
            ? `${quoted.text.slice(0, REPLY_SNIPPET_LEN)}…`
            : quoted.text;
      }
    }

    const now = Date.now();
    const row = this.ctx.storage.sql
      .exec<MessageRow>(
        `INSERT INTO messages (email, name, text, mentions, mention_all, reply_to, reply_name, reply_snippet, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
        who.email,
        who.name,
        text,
        JSON.stringify(mentions),
        mentionAll ? 1 : 0,
        replyTo,
        replyName,
        replySnippet,
        now,
      )
      .one();

    this.trim();
    this.broadcast({ type: 'message', message: row });
    await this.notifyOffline(who, text, mentions, mentionAll, now);
  }

  private handleReact(who: Attachment, msg: { id?: unknown; emoji?: unknown }) {
    const id = typeof msg.id === 'number' && Number.isInteger(msg.id) ? msg.id : null;
    const emoji = typeof msg.emoji === 'string' ? msg.emoji : '';
    if (id === null || !CHAT_EMOJI.includes(emoji)) return;

    const exists =
      this.ctx.storage.sql
        .exec('SELECT 1 AS x FROM messages WHERE id = ?', id)
        .toArray().length > 0;
    if (!exists) return;

    const had =
      this.ctx.storage.sql
        .exec(
          'SELECT 1 AS x FROM reactions WHERE message_id = ? AND email = ? AND emoji = ?',
          id,
          who.email,
          emoji,
        )
        .toArray().length > 0;

    if (had) {
      this.ctx.storage.sql.exec(
        'DELETE FROM reactions WHERE message_id = ? AND email = ? AND emoji = ?',
        id,
        who.email,
        emoji,
      );
    } else {
      this.ctx.storage.sql.exec(
        'INSERT INTO reactions (message_id, email, emoji, created_at) VALUES (?, ?, ?, ?)',
        id,
        who.email,
        emoji,
        Date.now(),
      );
    }
    this.broadcast({ type: 'reaction', id, emoji, email: who.email, on: !had });
  }

  private handleHistory(ws: WebSocket, msg: { before?: unknown }) {
    const before =
      typeof msg.before === 'number' && Number.isInteger(msg.before) ? msg.before : null;
    if (before === null) return;
    const messages = this.ctx.storage.sql
      .exec<MessageRow>(
        'SELECT * FROM messages WHERE id < ? ORDER BY id DESC LIMIT ?',
        before,
        PAGE_SIZE,
      )
      .toArray()
      .reverse();
    ws.send(
      JSON.stringify({
        type: 'history',
        messages,
        reactions: this.reactionsFor(messages.map((m) => m.id)),
      }),
    );
  }

  // ===== helpers ===========================================================

  private recentMessages(): MessageRow[] {
    return this.ctx.storage.sql
      .exec<MessageRow>('SELECT * FROM messages ORDER BY id DESC LIMIT ?', PAGE_SIZE)
      .toArray()
      .reverse();
  }

  private reactionsFor(ids: number[]): ReactionRow[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    return this.ctx.storage.sql
      .exec<ReactionRow>(
        `SELECT message_id, emoji, email FROM reactions WHERE message_id IN (${placeholders})`,
        ...ids,
      )
      .toArray();
  }

  private onlineUsers(): Attachment[] {
    const seen = new Map<string, Attachment>();
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() as Attachment | null;
      if (a && !seen.has(a.email)) seen.set(a.email, a);
    }
    return [...seen.values()];
  }

  private onlineEmails(): Set<string> {
    return new Set(this.onlineUsers().map((u) => u.email));
  }

  private broadcast(payload: unknown) {
    const data = JSON.stringify(payload);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(data);
      } catch {
        /* stale socket — close event will follow */
      }
    }
  }

  private broadcastOnline() {
    this.broadcast({ type: 'online', users: this.onlineUsers() });
  }

  private trim() {
    this.ctx.storage.sql.exec(
      `DELETE FROM reactions WHERE message_id NOT IN
         (SELECT id FROM messages ORDER BY id DESC LIMIT ?)`,
      MAX_MESSAGES,
    );
    this.ctx.storage.sql.exec(
      `DELETE FROM messages WHERE id NOT IN
         (SELECT id FROM messages ORDER BY id DESC LIMIT ?)`,
      MAX_MESSAGES,
    );
  }

  private async validEmails(emails: string[]): Promise<string[]> {
    if (emails.length === 0) return [];
    const unique = [...new Set(emails)];
    const placeholders = unique.map(() => '?').join(',');
    const { results } = await this.env.DB.prepare(
      `SELECT email FROM users WHERE email IN (${placeholders})`,
    )
      .bind(...unique)
      .all<{ email: string }>();
    return (results ?? []).map((r) => r.email);
  }

  /**
   * Bell notifications for @mentions. Recipients who are currently
   * connected saw the message live (and got a toast per their own
   * preference), so only the offline ones get a notifications row.
   */
  private async notifyOffline(
    who: Attachment,
    text: string,
    mentions: string[],
    mentionAll: boolean,
    now: number,
  ) {
    if (!mentionAll && mentions.length === 0) return;

    let recipients: string[];
    if (mentionAll) {
      const { results } = await this.env.DB.prepare('SELECT email FROM users')
        .all<{ email: string }>();
      recipients = (results ?? []).map((r) => r.email);
    } else {
      recipients = mentions;
    }

    const online = this.onlineEmails();
    const offline = recipients.filter((e) => e !== who.email && !online.has(e));
    if (offline.length === 0) return;

    const preview =
      text.length > PREVIEW_LEN ? `${text.slice(0, PREVIEW_LEN)}…` : text;
    const stmt = this.env.DB.prepare(
      `INSERT INTO notifications (id, recipient, kind, question_id, comment_id, actor_email, preview, created_at)
       VALUES (?, ?, 'chat_mention', NULL, NULL, ?, ?, ?)`,
    );
    await this.env.DB.batch(
      offline.map((email) =>
        stmt.bind(crypto.randomUUID(), email, who.email, preview, now),
      ),
    );
  }
}

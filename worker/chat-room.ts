import { DurableObject } from "cloudflare:workers";
import type { Env } from "./types";

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
	mentions: string; // JSON array of emails
	mention_all: number; // 0 | 1
	reply_to: number | null;
	reply_name: string | null;
	reply_snippet: string | null;
	created_at: number;
	/** 撤回時間。非 null 代表這是一塊墓碑,`text` 已經被抹掉了。 */
	deleted_at: number | null;
};

type ReactionRow = { message_id: number; emoji: string; email: string };

const MAX_MESSAGES = 500;
const MAX_TEXT_LEN = 2000;
const MAX_MENTIONS = 25;
const PAGE_SIZE = 50;
const REPLY_SNIPPET_LEN = 80;
const PREVIEW_LEN = 120;

// Fixed reaction palette — anything else is rejected server-side.
export const CHAT_EMOJI = ["👍", "❤️", "😂", "😮", "🙏", "🔥", "🎉"];

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
		// 冪等:client 產生的訊息 id(cid)。已部署的 DO 早已有 messages 表,
		// ADD COLUMN 沒有 IF NOT EXISTS —— 第二次啟動會丟「duplicate column」,
		// 用 try/catch 守住(既有列的 client_id 為 NULL,SQLite 允許多個 NULL
		// 並存於 UNIQUE index,不影響沒帶 cid 的舊訊息流)。
		try {
			this.ctx.storage.sql.exec(
				"ALTER TABLE messages ADD COLUMN client_id TEXT",
			);
		} catch {
			/* 欄位已存在 —— 忽略 */
		}
		// 撤回。同上,ADD COLUMN 沒有 IF NOT EXISTS,第二次啟動要靠 try/catch。
		try {
			this.ctx.storage.sql.exec(
				"ALTER TABLE messages ADD COLUMN deleted_at INTEGER",
			);
		} catch {
			/* 欄位已存在 —— 忽略 */
		}
		this.ctx.storage.sql.exec(
			"CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_client_id ON messages(client_id)",
		);
		// Keepalive pings answered without waking the DO out of hibernation.
		this.ctx.setWebSocketAutoResponse(
			new WebSocketRequestResponsePair("ping", "pong"),
		);
	}

	async fetch(request: Request): Promise<Response> {
		if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
			return new Response("expected websocket", { status: 426 });
		}
		const email = decodeURIComponent(request.headers.get("X-Chat-Email") ?? "");
		const name = decodeURIComponent(request.headers.get("X-Chat-Name") ?? "");
		if (!email) return new Response("missing identity", { status: 400 });

		const pair = new WebSocketPair();
		const [client, server] = [pair[0], pair[1]];
		this.ctx.acceptWebSocket(server);
		server.serializeAttachment({ email, name: name || email.split("@")[0] });

		server.send(
			JSON.stringify({
				type: "init",
				messages: this.recentMessages(),
				reactions: this.reactionsFor(this.recentMessages().map((m) => m.id)),
				online: this.onlineUsers(),
			}),
		);
		this.broadcastOnline();

		return new Response(null, { status: 101, webSocket: client });
	}

	async webSocketMessage(ws: WebSocket, raw: ArrayBuffer | string) {
		if (typeof raw !== "string" || raw.length > MAX_TEXT_LEN * 4) return;
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
				case "send":
					await this.handleSend(who, msg);
					break;
				case "react":
					this.handleReact(who, msg);
					break;
				case "recall":
					await this.handleRecall(who, msg);
					break;
				case "history":
					this.handleHistory(ws, msg);
					break;
			}
		} catch (err) {
			console.error("[chat] message failed", String(err));
			try {
				ws.send(JSON.stringify({ type: "error", message: "訊息處理失敗" }));
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
		msg: {
			text?: unknown;
			mentions?: unknown;
			mentionAll?: unknown;
			replyTo?: unknown;
			cid?: unknown;
		},
	) {
		const text = typeof msg.text === "string" ? msg.text.trim() : "";
		if (!text || text.length > MAX_TEXT_LEN) return;

		// 冪等:client 產生的訊息 id。重送同一 cid → INSERT OR IGNORE 命中既有列,
		// 不再新增、不廣播。沒帶 cid(舊 client)→ NULL,行為與現況完全一致。
		const cid =
			typeof msg.cid === "string" && msg.cid.length > 0 && msg.cid.length <= 200
				? msg.cid
				: null;

		const mentionAll = msg.mentionAll === true;
		const rawMentions = Array.isArray(msg.mentions)
			? msg.mentions
					.filter((m): m is string => typeof m === "string")
					.slice(0, MAX_MENTIONS)
			: [];
		// Only emails that actually exist in the roster count as mentions.
		const mentions = await this.validEmails(rawMentions);

		// Reply snapshot — survives even after the quoted message is trimmed.
		let replyTo: number | null = null;
		let replyName: string | null = null;
		let replySnippet: string | null = null;
		if (typeof msg.replyTo === "number" && Number.isInteger(msg.replyTo)) {
			const quoted = this.ctx.storage.sql
				.exec<MessageRow>("SELECT * FROM messages WHERE id = ?", msg.replyTo)
				.toArray()[0];
			if (quoted) {
				replyTo = quoted.id;
				replyName = quoted.name;
				// 引用一則**已撤回**的訊息:指標留著(還看得出在回誰),但快照留 null
				// —— 那正是 client 用來畫「訊息已撤回」的判準。抄一份空字串進去也行,
				// 但 null 與「這一列根本沒有回覆對象」的差別才是 client 分得出來的。
				replySnippet =
					quoted.deleted_at !== null && quoted.deleted_at !== undefined
						? null
						: quoted.text.length > REPLY_SNIPPET_LEN
							? `${quoted.text.slice(0, REPLY_SNIPPET_LEN)}…`
							: quoted.text;
			}
		}

		const now = Date.now();
		const inserted = this.ctx.storage.sql
			.exec<MessageRow>(
				`INSERT OR IGNORE INTO messages
           (email, name, text, mentions, mention_all, reply_to, reply_name, reply_snippet, client_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
				who.email,
				who.name,
				text,
				JSON.stringify(mentions),
				mentionAll ? 1 : 0,
				replyTo,
				replyName,
				replySnippet,
				cid,
				now,
			)
			.toArray();

		// INSERT OR IGNORE 命中既有 cid → 沒有 RETURNING 列 → 重送,直接略過
		// 廣播與離線通知(原始送出時早已廣播 + 通知過)。
		if (inserted.length === 0) return;
		const row = inserted[0];

		this.trim();
		this.broadcast({ type: "message", message: row });
		await this.notifyOffline(who, text, mentions, mentionAll, now);
	}

	/**
	 * 撤回自己的訊息。
	 *
	 * **是墓碑,不是刪列。** `id` 被 `reply_to`、`reactions` 與 `history` 的
	 * `WHERE id < ?` 分頁一起用著,整列刪掉會讓引用它的回覆指向一個不存在的東西
	 * (那顆跳轉鈕就變成按了沒反應)。留一列 `deleted_at` 非 null 的空殼,
	 * client 畫成「訊息已撤回」——那也是使用者預期看到的樣子。
	 *
	 * ⚠️ **但 `text` 一定要真的抹掉,不能只掛旗標。** 只掛旗標的話那不是撤回,
	 * 是「藏起來的訊息」:任何一條忘了看旗標的查詢(history、init、未來新增的
	 * 匯出)都會把它送回瀏覽器。
	 *
	 * ⚠️ **抹掉自己還不夠 —— 內容有兩份副本活在別的地方,而漏掉任何一份,
	 * 使用者看到的就是「按了撤回但字還在」:**
	 *
	 *   1. `reply_snippet` —— 回覆是**去正規化的快照**(刻意的:被引用的訊息
	 *      可能早就被 trim 掉了)。每一則引用它的回覆裡都存著一份文字。
	 *   2. D1 的 `notifications.preview` —— @ 到當時不在線的人時寫進去的。
	 *      不刪的話,那個人下次打開鈴鐺看到的還是原文。
	 *
	 * 沒有時間窗。加一個窗只是多一種「按了沒反應」,而這是自己的訊息 ——
	 * 20 個人的讀書會不需要那條規則。
	 */
	private async handleRecall(who: Attachment, msg: { id?: unknown }) {
		const id =
			typeof msg.id === "number" && Number.isInteger(msg.id) ? msg.id : null;
		if (id === null) return;

		const row = this.ctx.storage.sql
			.exec<MessageRow>("SELECT * FROM messages WHERE id = ?", id)
			.toArray()[0];
		// 只能撤回自己的,而且撤回過的不再處理(重按 / 重送不該再打一次 D1)。
		if (!row || row.email !== who.email || row.deleted_at) return;

		const now = Date.now();
		this.ctx.storage.sql.exec(
			`UPDATE messages
          SET text = '', mentions = '[]', mention_all = 0,
              reply_to = NULL, reply_name = NULL, reply_snippet = NULL,
              deleted_at = ?
        WHERE id = ?`,
			now,
			id,
		);
		// 表情符號跟著走:掛在一塊墓碑上的「👍 3」沒有東西可指。
		this.ctx.storage.sql.exec("DELETE FROM reactions WHERE message_id = ?", id);
		// 副本 1:引用它的那些回覆。
		this.ctx.storage.sql.exec(
			"UPDATE messages SET reply_snippet = NULL WHERE reply_to = ?",
			id,
		);

		this.broadcast({ type: "recall", id, deleted_at: now });
		await this.dropMentionNotifications(row);
	}

	/**
	 * 副本 2:離線 @ 通知。
	 *
	 * `notifications` 沒有 `message_id` 欄位,但 `notifyOffline` 是拿**訊息本身的
	 * `created_at`** 當那批列的 `created_at` 的(同一個 `now` 同時寫兩邊)——
	 * 所以 `(actor_email, created_at)` 就是精確對應。同 CLAUDE.md「答題狀態分析」
	 * 那節靠 timestamp 接 `confidence_events` 的作法;哪天把兩邊的時間戳拆開寫,
	 * 這裡會靜默變成刪不到而不是報錯。
	 */
	private async dropMentionNotifications(row: MessageRow) {
		if (row.mention_all !== 1 && row.mentions === "[]") return;
		await this.env.DB.prepare(
			`DELETE FROM notifications
        WHERE kind = 'chat_mention' AND actor_email = ? AND created_at = ?`,
		)
			.bind(row.email, row.created_at)
			.run();
	}

	private handleReact(who: Attachment, msg: { id?: unknown; emoji?: unknown }) {
		const id =
			typeof msg.id === "number" && Number.isInteger(msg.id) ? msg.id : null;
		const emoji = typeof msg.emoji === "string" ? msg.emoji : "";
		if (id === null || !CHAT_EMOJI.includes(emoji)) return;

		// 撤回過的不收:墓碑上沒有東西可以反應,而 handleRecall 剛把既有的都刪了
		// —— 少了這道閘,「撤回 → 對方剛好按了個讚」會讓那個讚活下來。
		const exists =
			this.ctx.storage.sql
				.exec(
					"SELECT 1 AS x FROM messages WHERE id = ? AND deleted_at IS NULL",
					id,
				)
				.toArray().length > 0;
		if (!exists) return;

		const had =
			this.ctx.storage.sql
				.exec(
					"SELECT 1 AS x FROM reactions WHERE message_id = ? AND email = ? AND emoji = ?",
					id,
					who.email,
					emoji,
				)
				.toArray().length > 0;

		if (had) {
			this.ctx.storage.sql.exec(
				"DELETE FROM reactions WHERE message_id = ? AND email = ? AND emoji = ?",
				id,
				who.email,
				emoji,
			);
		} else {
			this.ctx.storage.sql.exec(
				"INSERT INTO reactions (message_id, email, emoji, created_at) VALUES (?, ?, ?, ?)",
				id,
				who.email,
				emoji,
				Date.now(),
			);
		}
		this.broadcast({ type: "reaction", id, emoji, email: who.email, on: !had });
	}

	private handleHistory(ws: WebSocket, msg: { before?: unknown }) {
		const before =
			typeof msg.before === "number" && Number.isInteger(msg.before)
				? msg.before
				: null;
		if (before === null) return;
		const messages = this.ctx.storage.sql
			.exec<MessageRow>(
				"SELECT * FROM messages WHERE id < ? ORDER BY id DESC LIMIT ?",
				before,
				PAGE_SIZE,
			)
			.toArray()
			.reverse();
		ws.send(
			JSON.stringify({
				type: "history",
				messages,
				reactions: this.reactionsFor(messages.map((m) => m.id)),
			}),
		);
	}

	// ===== helpers ===========================================================

	private recentMessages(): MessageRow[] {
		return this.ctx.storage.sql
			.exec<MessageRow>(
				"SELECT * FROM messages ORDER BY id DESC LIMIT ?",
				PAGE_SIZE,
			)
			.toArray()
			.reverse();
	}

	private reactionsFor(ids: number[]): ReactionRow[] {
		if (ids.length === 0) return [];
		const placeholders = ids.map(() => "?").join(",");
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
		this.broadcast({ type: "online", users: this.onlineUsers() });
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
		const placeholders = unique.map(() => "?").join(",");
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
			const { results } = await this.env.DB.prepare(
				"SELECT email FROM users",
			).all<{ email: string }>();
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

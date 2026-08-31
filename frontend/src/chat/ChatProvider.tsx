import {
	createContext,
	useContext,
	useEffect,
	useRef,
	useState,
	type ReactNode,
} from "react";
import { useLocation } from "react-router-dom";
import { useMe } from "../hooks/useMe";
import { applyRecall } from "./recall";

// ===== Wire types (mirror worker/chat-room.ts) ==============================

export type ChatMessage = {
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
	/** 撤回時間。非 null 代表這是一塊墓碑,`text` 在伺服器上已經被抹掉了。
	 *  舊訊息(欄位加進來之前)是 undefined —— 一律當成沒撤回。 */
	deleted_at?: number | null;
};

export type ChatReaction = { message_id: number; emoji: string; email: string };
export type ChatOnline = { email: string; name: string };
export type ChatToast = {
	key: number;
	email: string;
	name: string;
	text: string;
};

// Must match CHAT_EMOJI in worker/chat-room.ts — the server rejects others.
export const CHAT_EMOJI = ["👍", "❤️", "😂", "😮", "🙏", "🔥", "🎉"];

const PAGE_SIZE = 50;
const MAX_CLIENT_MESSAGES = 500;
const TOAST_MS = 6000;
const PING_MS = 30_000;

type SendOpts = { mentions: string[]; mentionAll: boolean; replyTo?: number };

type ChatContextValue = {
	connected: boolean;
	messages: ChatMessage[];
	reactions: Record<number, ChatReaction[]>;
	online: ChatOnline[];
	unread: number;
	hasMore: boolean;
	toasts: ChatToast[];
	send: (text: string, opts: SendOpts) => void;
	react: (id: number, emoji: string) => void;
	recall: (id: number) => void;
	loadOlder: () => void;
	clearUnread: () => void;
	dismissToast: (key: number) => void;
};

const ChatContext = createContext<ChatContextValue | null>(null);

export function useChat(): ChatContextValue {
	const ctx = useContext(ChatContext);
	if (!ctx) throw new Error("useChat must be used inside <ChatProvider>");
	return ctx;
}

function wsUrl(): string {
	const proto = window.location.protocol === "https:" ? "wss://" : "ws://";
	return `${proto}${window.location.host}/api/chat/ws`;
}

function groupReactions(rows: ChatReaction[]): Record<number, ChatReaction[]> {
	const out: Record<number, ChatReaction[]> = {};
	for (const r of rows) (out[r.message_id] ??= []).push(r);
	return out;
}

export function ChatProvider({ children }: { children: ReactNode }) {
	const { me } = useMe();
	const location = useLocation();

	const [connected, setConnected] = useState(false);
	const [messages, setMessages] = useState<ChatMessage[]>([]);
	const [reactions, setReactions] = useState<Record<number, ChatReaction[]>>(
		{},
	);
	const [online, setOnline] = useState<ChatOnline[]>([]);
	const [unread, setUnread] = useState(0);
	const [hasMore, setHasMore] = useState(false);
	const [toasts, setToasts] = useState<ChatToast[]>([]);

	const wsRef = useRef<WebSocket | null>(null);

	// The WS onmessage closure is long-lived; read the latest identity,
	// preference and route through refs instead of re-connecting on change.
	const meRef = useRef(me);
	meRef.current = me;
	const pathRef = useRef(location.pathname);
	pathRef.current = location.pathname;

	useEffect(() => {
		// Per-effect-instance lifecycle flags (NOT shared refs): under React
		// StrictMode the effect mounts twice, and a shared "alive" ref lets the
		// first socket's async onclose fire after the second mount re-armed it —
		// spawning a duplicate connection that double-delivers every broadcast.
		let alive = true;
		let attempt = 0;
		let timer: number | null = null;

		function handleIncoming(raw: string) {
			let msg: any;
			try {
				msg = JSON.parse(raw);
			} catch {
				return;
			}
			switch (msg?.type) {
				case "init":
					setMessages(msg.messages ?? []);
					setReactions(groupReactions(msg.reactions ?? []));
					setOnline(msg.online ?? []);
					setHasMore((msg.messages ?? []).length >= PAGE_SIZE);
					break;
				case "message": {
					const m = msg.message as ChatMessage;
					setMessages((list) =>
						list.some((x) => x.id === m.id)
							? list
							: [...list, m].slice(-MAX_CLIENT_MESSAGES),
					);
					onNewMessage(m);
					break;
				}
				case "reaction": {
					const { id, emoji, email, on } = msg as {
						id: number;
						emoji: string;
						email: string;
						on: boolean;
					};
					setReactions((map) => {
						const cur = map[id] ?? [];
						const next = on
							? [...cur, { message_id: id, emoji, email }]
							: cur.filter((r) => !(r.emoji === emoji && r.email === email));
						return { ...map, [id]: next };
					});
					break;
				}
				case "recall": {
					const { id, deleted_at } = msg as { id: number; deleted_at: number };
					// 訊息與所有引用它的回覆快照 —— 抽成純函式,因為它要回答的是
					// 「這則訊息的內容還有幾份」,而那是有測試守著的(recall.test.ts)。
					setMessages((list) => applyRecall(list, id, deleted_at));
					setReactions((map) => {
						if (!(id in map)) return map;
						const next = { ...map };
						delete next[id];
						return next;
					});
					// 還飄在畫面上的那則 toast 也要收掉(toast 的 key 就是訊息 id)。
					// 收不回已經讀過的那一眼,但至少不要讓它繼續留在螢幕上。
					setToasts((list) => list.filter((t) => t.key !== id));
					break;
				}
				case "online":
					setOnline(msg.users ?? []);
					break;
				case "history": {
					const older = (msg.messages ?? []) as ChatMessage[];
					setMessages((list) => [...older, ...list]);
					setReactions((map) => ({
						...groupReactions(msg.reactions ?? []),
						...map,
					}));
					setHasMore(older.length >= PAGE_SIZE);
					break;
				}
			}
		}

		function onNewMessage(m: ChatMessage) {
			const self = meRef.current;
			if (!self || m.email === self.email) return;

			const onChatPage = pathRef.current === "/chat" && !document.hidden;
			if (!onChatPage) setUnread((u) => u + 1);

			const pref = self.chat_notify ?? "mention";
			if (pref === "off" || onChatPage) return;
			let mentioned = m.mention_all === 1;
			if (!mentioned) {
				try {
					mentioned = (JSON.parse(m.mentions) as string[]).includes(self.email);
				} catch {
					/* malformed mentions — treat as none */
				}
			}
			if (pref === "mention" && !mentioned) return;

			const toast: ChatToast = {
				key: m.id,
				email: m.email,
				name: m.name,
				text: m.text,
			};
			setToasts((list) => [...list.slice(-2), toast]);
			window.setTimeout(() => {
				setToasts((list) => list.filter((t) => t.key !== toast.key));
			}, TOAST_MS);
		}

		function connect() {
			if (!alive) return;
			const ws = new WebSocket(wsUrl());
			wsRef.current = ws;

			ws.onopen = () => {
				attempt = 0;
				setConnected(true);
			};
			ws.onmessage = (e) => {
				if (typeof e.data === "string" && e.data !== "pong")
					handleIncoming(e.data);
			};
			ws.onclose = () => {
				setConnected(false);
				if (!alive) return;
				const delay = Math.min(30_000, 1000 * 2 ** attempt);
				attempt += 1;
				timer = window.setTimeout(connect, delay);
			};
			ws.onerror = () => {
				ws.close();
			};
		}

		connect();

		const ping = window.setInterval(() => {
			if (wsRef.current?.readyState === WebSocket.OPEN)
				wsRef.current.send("ping");
		}, PING_MS);

		// Coming back to the tab: if the socket dropped while asleep, retry now.
		function onVisible() {
			if (
				!document.hidden &&
				alive &&
				wsRef.current?.readyState !== WebSocket.OPEN &&
				wsRef.current?.readyState !== WebSocket.CONNECTING
			) {
				if (timer !== null) window.clearTimeout(timer);
				attempt = 0;
				connect();
			}
		}
		document.addEventListener("visibilitychange", onVisible);

		return () => {
			alive = false;
			document.removeEventListener("visibilitychange", onVisible);
			window.clearInterval(ping);
			if (timer !== null) window.clearTimeout(timer);
			wsRef.current?.close();
		};
	}, []);

	function sendRaw(payload: unknown) {
		if (wsRef.current?.readyState === WebSocket.OPEN) {
			wsRef.current.send(JSON.stringify(payload));
		}
	}

	const value: ChatContextValue = {
		connected,
		messages,
		reactions,
		online,
		unread,
		hasMore,
		toasts,
		send: (text, opts) =>
			sendRaw({
				type: "send",
				text,
				mentions: opts.mentions,
				mentionAll: opts.mentionAll,
				replyTo: opts.replyTo,
			}),
		react: (id, emoji) => sendRaw({ type: "react", id, emoji }),
		// 伺服器只認送出者本人(見 handleRecall),所以這裡不必先檢查 —— 檢查兩次
		// 的話,哪天判準改了會有一邊沒跟上,而那一邊是**看得見**的那一邊。
		recall: (id) => sendRaw({ type: "recall", id }),
		loadOlder: () => {
			const oldest = messages[0];
			if (oldest) sendRaw({ type: "history", before: oldest.id });
		},
		clearUnread: () => setUnread(0),
		dismissToast: (key) =>
			setToasts((list) => list.filter((t) => t.key !== key)),
	};

	return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}

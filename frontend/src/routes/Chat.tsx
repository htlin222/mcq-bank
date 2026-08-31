import {
	Fragment,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useChat } from "../chat/ChatProvider";
import { MessageItem } from "../chat/MessageItem";
import { Composer, type ReplyDraft } from "../chat/Composer";
import { dayLabel } from "../chat/chatText";
import { useMe } from "../hooks/useMe";
import { useSessionDraft } from "../hooks/useSessionDraft";
import { useUsers } from "../hooks/useUsers";

export function Chat() {
	const { me, update } = useMe();
	const { users } = useUsers();
	const {
		connected,
		messages,
		reactions,
		online,
		hasMore,
		send,
		react,
		recall,
		loadOlder,
		clearUnread,
	} = useChat();

	// Reply target rides along with the chat draft across route switches.
	const [reply, setReply] = useSessionDraft<ReplyDraft | null>(
		"chat-reply",
		null,
	);
	const [paletteFor, setPaletteFor] = useState<number | null>(null);
	// 撤回的第二段確認。**跟表情面板一樣記在這裡而不是 MessageItem 裡**,
	// 這樣底下那個「點訊息區就收起來」的 onClick 一次收掉兩者 —— 各自記一份的話,
	// 一定會有一個關不掉,而使用者只會覺得「有些東西關得掉、有些關不掉」。
	const [recallFor, setRecallFor] = useState<number | null>(null);

	const scrollRef = useRef<HTMLDivElement>(null);
	const nearBottomRef = useRef(true);
	const prependRef = useRef<number | null>(null); // scrollHeight before "load older"

	const nameByEmail = useMemo(() => {
		const m = new Map<string, string>();
		for (const u of users) m.set(u.email, u.display_name);
		return m;
	}, [users]);
	const avatarByEmail = useMemo(() => {
		const m = new Map<string, string | null>();
		for (const u of users) m.set(u.email, u.avatar_key);
		return m;
	}, [users]);
	const names = useMemo(() => users.map((u) => u.display_name), [users]);

	// Entering the page (and every message seen while visible) clears unread.
	useEffect(() => {
		if (!document.hidden) clearUnread();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [messages.length]);

	// Stick to the bottom unless the reader scrolled up; after "load older",
	// keep the viewport anchored on what they were reading.
	useLayoutEffect(() => {
		const el = scrollRef.current;
		if (!el) return;
		if (prependRef.current !== null) {
			el.scrollTop += el.scrollHeight - prependRef.current;
			prependRef.current = null;
		} else if (nearBottomRef.current) {
			el.scrollTop = el.scrollHeight;
		}
	}, [messages]);

	function onScroll() {
		const el = scrollRef.current;
		if (!el) return;
		nearBottomRef.current =
			el.scrollHeight - el.scrollTop - el.clientHeight < 120;
	}

	function jumpTo(id: number) {
		const el = document.getElementById(`chat-msg-${id}`);
		if (!el) return;
		el.scrollIntoView({ behavior: "smooth", block: "center" });
		el.classList.add("bg-accent/10");
		window.setTimeout(() => el.classList.remove("bg-accent/10"), 1600);
	}

	const pref = me?.chat_notify ?? "mention";

	return (
		<div className="mx-auto max-w-3xl w-full px-0 sm:px-6 flex flex-col h-[calc(100dvh-var(--header-h)-var(--bottom-nav-h))]">
			{/* Page header: title, presence, notify preference */}
			<div className="flex items-center gap-3 px-4 sm:px-0 py-3 border-b border-ink-200 dark:border-ink-700">
				<h1 className="font-serif text-lg text-ink-900 dark:text-ink-100">
					聊天大廳
				</h1>
				<span
					className="text-xs text-ink-500 dark:text-ink-400"
					title={online.map((o) => o.name).join("、")}
				>
					{online.length} 人在線
				</span>
				{!connected && (
					<span className="text-xs text-amber-600 dark:text-amber-400 animate-pulse">
						連線中…
					</span>
				)}
				<div
					className="ml-auto flex items-center gap-1 text-xs"
					role="radiogroup"
					aria-label="通知偏好"
				>
					<span className="text-ink-400 dark:text-ink-500 mr-1 hidden sm:inline">
						通知
					</span>
					{(
						[
							["all", "全部"],
							["mention", "僅@我"],
							["off", "關閉"],
						] as const
					).map(([value, label]) => (
						<button
							key={value}
							role="radio"
							aria-checked={pref === value}
							onClick={() => update({ chat_notify: value })}
							className={`px-2 py-1 rounded transition ${
								pref === value
									? "bg-accent text-white"
									: "text-ink-500 dark:text-ink-400 hover:bg-ink-100 dark:hover:bg-ink-700"
							}`}
						>
							{label}
						</button>
					))}
				</div>
			</div>

			{/* Messages */}
			<div
				ref={scrollRef}
				onScroll={onScroll}
				onClick={() => {
					setPaletteFor(null);
					setRecallFor(null);
				}}
				className="flex-1 overflow-y-auto overflow-x-hidden px-4 sm:px-2 pt-3 pb-4"
			>
				{hasMore && (
					<div className="text-center mb-3">
						<button
							onClick={() => {
								prependRef.current = scrollRef.current?.scrollHeight ?? null;
								loadOlder();
							}}
							className="text-xs text-accent hover:text-accent-dark px-3 py-1 rounded border border-ink-200 dark:border-ink-700"
						>
							載入更早的訊息
						</button>
					</div>
				)}
				{messages.length === 0 && (
					<div className="text-center text-sm text-ink-400 dark:text-ink-500 py-16">
						還沒有訊息——當第一個開口的人吧。
					</div>
				)}
				{messages.map((m, i) => {
					const prev = messages[i - 1];
					const newDay =
						!prev ||
						new Date(prev.created_at).toDateString() !==
							new Date(m.created_at).toDateString();
					return (
						<Fragment key={m.id}>
							{newDay && (
								<div className="flex items-center gap-3 my-4">
									<div className="flex-1 h-px bg-ink-200 dark:bg-ink-700" />
									<span className="text-[11px] text-ink-400 dark:text-ink-500">
										{dayLabel(m.created_at)}
									</span>
									<div className="flex-1 h-px bg-ink-200 dark:bg-ink-700" />
								</div>
							)}
							<MessageItem
								m={m}
								reactions={reactions[m.id] ?? []}
								mine={me?.email === m.email}
								myEmail={me?.email ?? null}
								names={names}
								avatarKey={avatarByEmail.get(m.email) ?? null}
								nameOf={(email) =>
									nameByEmail.get(email) ?? email.split("@")[0]
								}
								paletteOpen={paletteFor === m.id}
								onTogglePalette={() =>
									setPaletteFor(paletteFor === m.id ? null : m.id)
								}
								onReact={(emoji) => react(m.id, emoji)}
								confirmRecall={recallFor === m.id}
								onAskRecall={() => {
									setPaletteFor(null);
									setRecallFor(m.id);
								}}
								onRecall={() => {
									recall(m.id);
									setRecallFor(null);
									// 正在回覆這一則就把草稿一起撤掉 —— 引用區留著原文的話,
									// 「撤回了但字還在我自己的輸入框上」。
									if (reply?.id === m.id) setReply(null);
								}}
								onReply={() =>
									setReply({
										id: m.id,
										name: m.name,
										snippet:
											m.text.length > 60 ? `${m.text.slice(0, 60)}…` : m.text,
									})
								}
								onJumpTo={jumpTo}
							/>
						</Fragment>
					);
				})}
			</div>

			<Composer
				users={users}
				myEmail={me?.email ?? null}
				connected={connected}
				reply={reply}
				onCancelReply={() => setReply(null)}
				onSend={(text, mentions, mentionAll) => {
					send(text, { mentions, mentionAll, replyTo: reply?.id });
					setReply(null);
					nearBottomRef.current = true;
				}}
			/>
		</div>
	);
}

import { CornerUpLeft, SmilePlus } from 'lucide-react';
import { CHAT_EMOJI, type ChatMessage, type ChatReaction } from './ChatProvider';
import { renderChatText, timeLabel } from './chatText';
import { Avatar } from '../components/Avatar';

type Props = {
  m: ChatMessage;
  reactions: ChatReaction[];
  mine: boolean;
  myEmail: string | null;
  avatarKey: string | null;
  names: string[];
  nameOf: (email: string) => string;
  paletteOpen: boolean;
  onTogglePalette: () => void;
  onReact: (emoji: string) => void;
  onReply: () => void;
  onJumpTo: (id: number) => void;
};

/** Messenger-style row: own messages right-aligned on an accent bubble,
 *  others left-aligned with avatar + name. */
export function MessageItem({
  m,
  reactions,
  mine,
  myEmail,
  avatarKey,
  names,
  nameOf,
  paletteOpen,
  onTogglePalette,
  onReact,
  onReply,
  onJumpTo,
}: Props) {
  const byEmoji = new Map<string, string[]>();
  for (const r of reactions) {
    byEmoji.set(r.emoji, [...(byEmoji.get(r.emoji) ?? []), r.email]);
  }

  return (
    <div
      id={`chat-msg-${m.id}`}
      className={`group flex gap-2 py-1 px-1 rounded transition-colors ${
        mine ? 'flex-row-reverse' : ''
      }`}
    >
      {!mine && (
        <div className="pt-5 shrink-0 self-start">
          <Avatar email={m.email} avatarKey={avatarKey} name={m.name} size={30} />
        </div>
      )}

      <div
        className={`min-w-0 max-w-[85%] sm:max-w-[70%] flex flex-col ${
          mine ? 'items-end' : 'items-start'
        }`}
      >
        {!mine && (
          <div className="flex items-baseline gap-2 mb-0.5 px-1">
            <span className="text-xs font-medium text-ink-600 dark:text-ink-300">
              {m.name}
            </span>
            <time className="text-[10px] text-ink-400 dark:text-ink-500">
              {timeLabel(m.created_at)}
            </time>
          </div>
        )}

        <div
          className={
            mine
              ? 'bg-accent text-white rounded-2xl rounded-br-md px-3 py-2'
              : 'bg-white dark:bg-ink-800 border border-ink-200 dark:border-ink-700 text-ink-800 dark:text-ink-200 rounded-2xl rounded-bl-md px-3 py-2'
          }
        >
          {m.reply_to !== null && (
            <button
              onClick={() => onJumpTo(m.reply_to!)}
              className={`mb-1 flex items-center gap-1.5 text-xs border-l-2 pl-2 max-w-full transition text-left ${
                mine
                  ? 'border-white/50 text-white/85 hover:text-white'
                  : 'border-ink-300 dark:border-ink-600 text-ink-500 dark:text-ink-400 hover:border-accent hover:text-ink-700 dark:hover:text-ink-200'
              }`}
            >
              <CornerUpLeft size={12} className="shrink-0" />
              <span className="font-medium shrink-0">{m.reply_name}</span>
              <span className="truncate">{m.reply_snippet}</span>
            </button>
          )}
          <div className="text-sm whitespace-pre-wrap break-words leading-relaxed">
            {renderChatText(m.text, names, mine)}
          </div>
        </div>

        {byEmoji.size > 0 && (
          <div className={`flex flex-wrap gap-1 mt-1 ${mine ? 'justify-end' : ''}`}>
            {[...byEmoji.entries()].map(([emoji, emails]) => {
              const iReacted = myEmail !== null && emails.includes(myEmail);
              return (
                <button
                  key={emoji}
                  onClick={() => onReact(emoji)}
                  title={emails.map(nameOf).join('、')}
                  className={`text-xs px-1.5 py-0.5 rounded-full border transition ${
                    iReacted
                      ? 'border-accent bg-accent/10 text-accent'
                      : 'border-ink-200 dark:border-ink-600 bg-white dark:bg-ink-800 text-ink-600 dark:text-ink-300 hover:border-ink-400'
                  }`}
                >
                  {emoji} {emails.length}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Hover actions beside the bubble (own message: time shows on hover) */}
      <div className="relative self-center flex items-center gap-0.5 opacity-60 sm:opacity-0 sm:group-hover:opacity-100 transition">
        {mine && (
          <time className="text-[10px] text-ink-400 dark:text-ink-500 mr-1 hidden sm:block">
            {timeLabel(m.created_at)}
          </time>
        )}
        <button
          aria-label="加上表情"
          onClick={(e) => {
            e.stopPropagation();
            onTogglePalette();
          }}
          className="w-7 h-7 grid place-items-center rounded-full bg-white dark:bg-ink-800 border border-ink-200 dark:border-ink-600 text-ink-500 hover:text-accent"
        >
          <SmilePlus size={14} />
        </button>
        <button
          aria-label="回覆"
          onClick={onReply}
          className="w-7 h-7 grid place-items-center rounded-full bg-white dark:bg-ink-800 border border-ink-200 dark:border-ink-600 text-ink-500 hover:text-accent"
        >
          <CornerUpLeft size={14} />
        </button>
        {paletteOpen && (
          <div
            className={`absolute bottom-full mb-1.5 z-10 flex gap-1 bg-white dark:bg-ink-800 border border-ink-200 dark:border-ink-600 rounded-full shadow-lg px-2.5 py-1.5 ${
              mine ? 'right-0' : 'left-0'
            }`}
            onClick={(e) => e.stopPropagation()}
          >
            {CHAT_EMOJI.map((emoji) => (
              <button
                key={emoji}
                onClick={() => {
                  onReact(emoji);
                  onTogglePalette();
                }}
                className="text-lg hover:scale-125 transition-transform"
              >
                {emoji}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

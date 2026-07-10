import { Link, useLocation } from 'react-router-dom';
import { MessagesSquare } from 'lucide-react';
import { useChat } from './ChatProvider';

/** Header entry to 聊天大廳 with unread badge — visible on mobile too. */
export function ChatBell() {
  const { unread } = useChat();
  const { pathname } = useLocation();
  const active = pathname === '/chat';

  return (
    <Link
      to="/chat"
      aria-label="聊天大廳"
      className={`relative w-9 h-9 grid place-items-center rounded-full hover:bg-ink-100 dark:hover:bg-ink-800 transition ${
        active ? 'text-accent' : 'text-ink-600 dark:text-ink-300'
      }`}
    >
      <MessagesSquare size={18} />
      {unread > 0 && (
        <span className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] px-1 text-[10px] font-semibold bg-accent text-white rounded-full grid place-items-center">
          {unread > 99 ? '99+' : unread}
        </span>
      )}
    </Link>
  );
}

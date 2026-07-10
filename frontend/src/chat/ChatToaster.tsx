import { useNavigate } from 'react-router-dom';
import { X } from 'lucide-react';
import { useChat } from './ChatProvider';
import { useUsers } from '../hooks/useUsers';
import { Avatar } from '../components/Avatar';

/**
 * 聊天大廳 toast — fixed under the header, top-centre on mobile and
 * top-right on desktop. Click navigates to /chat; auto-dismisses after a
 * few seconds (timer lives in ChatProvider).
 */
export function ChatToaster() {
  const { toasts, dismissToast } = useChat();
  const { users } = useUsers();
  const navigate = useNavigate();

  if (toasts.length === 0) return null;

  return (
    <div className="fixed top-16 left-1/2 -translate-x-1/2 sm:left-auto sm:translate-x-0 sm:right-4 z-50 flex flex-col gap-2 w-[calc(100vw-2rem)] max-w-sm">
      {toasts.map((t) => {
        const avatarKey = users.find((u) => u.email === t.email)?.avatar_key ?? null;
        return (
          <div
            key={t.key}
            role="status"
            className="flex items-start gap-3 bg-white dark:bg-ink-800 border border-ink-200 dark:border-ink-700 rounded-lg shadow-lg px-4 py-3 animate-fade-in cursor-pointer hover:border-accent transition"
            onClick={() => {
              dismissToast(t.key);
              navigate('/chat');
            }}
          >
            <Avatar email={t.email} avatarKey={avatarKey} name={t.name} size={32} />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-ink-900 dark:text-ink-100">
                {t.name}
                <span className="ml-2 text-[11px] font-normal text-ink-400 dark:text-ink-500">
                  聊天大廳
                </span>
              </div>
              <div className="text-sm text-ink-600 dark:text-ink-300 line-clamp-2 break-words">
                {t.text}
              </div>
            </div>
            <button
              aria-label="關閉"
              className="shrink-0 text-ink-400 hover:text-ink-600 dark:hover:text-ink-200"
              onClick={(e) => {
                e.stopPropagation();
                dismissToast(t.key);
              }}
            >
              <X size={16} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Bell } from 'lucide-react';
import { api } from '../lib/api';

type Notification = {
  id: string;
  recipient: string;
  kind:
    | 'mention'
    | 'reply'
    | 'edit'
    | 'challenge_filed'
    | 'challenge_promoted'
    | 'challenge_rejected';
  question_id: string | null;
  challenge_id: string | null;
  actor_email: string | null;
  preview: string;
  read_at: number | null;
  created_at: number;
};

function notificationLabel(n: Notification): string {
  switch (n.kind) {
    case 'mention':
      return '提到了你';
    case 'reply':
      return '回覆了你的留言';
    case 'edit':
      return '更新了詳解';
    case 'challenge_filed':
      return '對本題答案發起挑戰';
    case 'challenge_promoted':
      return '本題答案已由社群修正';
    case 'challenge_rejected':
      return '挑戰未通過';
  }
}

export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [count, setCount] = useState(0);
  const [items, setItems] = useState<Notification[]>([]);
  const ref = useRef<HTMLDivElement>(null);

  // Poll unread count every 60s (no SSE/WS in v1 — keep simple)
  useEffect(() => {
    let alive = true;
    async function poll() {
      try {
        const r = await api.get<{ count: number }>('/api/notifications/unread-count');
        if (alive) setCount(r.count ?? 0);
      } catch {
        /* ignore */
      }
    }
    poll();
    const t = window.setInterval(poll, 60_000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, []);

  // Outside click to close
  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  async function openPanel() {
    setOpen(true);
    try {
      const list = await api.get<Notification[]>('/api/notifications?unread=1');
      setItems(list);
    } catch {
      setItems([]);
    }
  }

  async function markAllRead() {
    await api.post('/api/notifications/read-all');
    setCount(0);
    setItems((list) => list.map((n) => ({ ...n, read_at: Date.now() })));
  }

  return (
    <div ref={ref} className="relative">
      <button
        onClick={open ? () => setOpen(false) : openPanel}
        className="relative w-9 h-9 grid place-items-center rounded-full hover:bg-ink-100 dark:hover:bg-ink-800 transition text-ink-600 dark:text-ink-300"
        aria-label="通知"
      >
        <Bell size={18} />
        {count > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] px-1 text-[10px] font-semibold bg-accent text-white rounded-full grid place-items-center">
            {count > 99 ? '99+' : count}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-11 w-80 max-w-[calc(100vw-2rem)] bg-white dark:bg-ink-800 border border-ink-200 dark:border-ink-700 rounded-lg shadow-lg overflow-hidden z-50 animate-fade-in">
          <header className="flex items-center justify-between px-4 py-3 border-b border-ink-100 dark:border-ink-700">
            <h3 className="font-serif text-base text-ink-800 dark:text-ink-100">通知</h3>
            {count > 0 && (
              <button
                onClick={markAllRead}
                className="text-xs text-accent hover:text-accent-dark"
              >
                全部標為已讀
              </button>
            )}
          </header>
          <div className="max-h-96 overflow-y-auto">
            {items.length === 0 ? (
              <div className="px-4 py-10 text-center text-sm text-ink-400 dark:text-ink-500">
                沒有未讀通知
              </div>
            ) : (
              items.map((n) => (
                <Link
                  key={n.id}
                  to={n.question_id ? `/q/${n.question_id}` : '/'}
                  onClick={() => setOpen(false)}
                  className="block px-4 py-3 border-b border-ink-50 dark:border-ink-700 hover:bg-ink-50 dark:hover:bg-ink-700 last:border-0"
                >
                  <div className="text-sm text-ink-700 dark:text-ink-200">
                    {n.actor_email && (
                      <span className="font-medium text-ink-900 dark:text-ink-100">{n.actor_email}</span>
                    )}
                    {n.actor_email ? ' ' : ''}
                    {notificationLabel(n)}
                  </div>
                  <div className="text-xs text-ink-500 dark:text-ink-400 mt-1 line-clamp-2">
                    {n.preview}
                  </div>
                  <time className="text-[11px] text-ink-400 dark:text-ink-500 mt-1 block">
                    {new Date(n.created_at).toLocaleString('zh-TW')}
                  </time>
                </Link>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

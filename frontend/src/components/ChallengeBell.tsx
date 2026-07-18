import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Scale } from 'lucide-react';
import { api } from '../lib/api';

/**
 * Header entry to 答案挑戰 with a small "有表決中挑戰" dot — mirrors ChatBell's
 * unread indicator. A challenge is 表決中 while its status is open/contested,
 * which is exactly what GET /api/challenges/recent returns when called without
 * `include` (open+contested only). So a `length > 0` check needs no new API —
 * `limit=1` keeps the payload to at most one row.
 */
export function ChallengeBell() {
  const [hasActive, setHasActive] = useState(false);
  const { pathname } = useLocation();
  const active = pathname === '/challenges';

  // Poll every 60s — same cadence as NotificationBell (no SSE/WS here).
  useEffect(() => {
    let alive = true;
    async function poll() {
      try {
        const rows = await api.get<unknown[]>('/api/challenges/recent?limit=1');
        if (alive) setHasActive(Array.isArray(rows) && rows.length > 0);
      } catch {
        /* the dot is a nicety — never block the header on it */
      }
    }
    poll();
    const t = window.setInterval(poll, 60_000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, []);

  return (
    <Link
      to="/challenges"
      aria-label={hasActive ? '答案挑戰(有表決中)' : '答案挑戰'}
      className={`relative w-9 h-9 grid place-items-center rounded-full hover:bg-ink-100 dark:hover:bg-ink-800 transition ${
        active ? 'text-accent' : 'text-ink-600 dark:text-ink-300'
      }`}
    >
      <Scale size={18} />
      {hasActive && (
        <span className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 bg-accent rounded-full ring-2 ring-white dark:ring-ink-900" />
      )}
    </Link>
  );
}

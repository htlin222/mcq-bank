import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Avatar } from './Avatar';

type Online = {
  email: string;
  display_name: string;
  avatar_key: string | null;
  last_seen_at: number;
};

const MAX_VISIBLE = 5;
const POLL_MS = 90_000;

export function OnlineUsers() {
  const [users, setUsers] = useState<Online[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    async function poll() {
      try {
        const r = await api.get<Online[]>('/api/users/online');
        if (alive) setUsers(r);
      } catch {/* ignore */}
    }
    poll();
    const t = window.setInterval(poll, POLL_MS);
    return () => { alive = false; window.clearInterval(t); };
  }, []);

  if (users.length === 0) {
    return null;
  }

  const visible = users.slice(0, MAX_VISIBLE);
  const more = users.length - visible.length;

  return (
    <div
      // #94 當初把整塊推到 lg,理由是「寬度隨線上人數變動,是整條 header 唯一
      // 寬度不固定的東西」。但真正讓斷點算不準的不是「會變」,而是**最大寬度
      // 不可預測** —— 頭像列從 1 顆到 5 顆,差了 100px 以上,而那取決於當下有
      // 幾個人在線。
      //
      // 所以改成兩種形態,各自的**上界**都是固定的:md–lg 只出一顆計數徽章
      // (綠點 + 人數,tabular-nums 讓數字等寬,寬度只隨位數變),lg 起才展開
      // 頭像列。斷點於是按各自的上界就算得準,而 md–lg 那段也拿回了視覺重量
      // ——「有人在線」這件事本來就不該只在寬螢幕看得見。
      className="relative hidden md:flex items-center"
      onMouseLeave={() => setOpen(false)}
    >
      {/* md–lg:固定寬度的計數徽章 */}
      <button
        onClick={() => setOpen((v) => !v)}
        className="lg:hidden flex items-center gap-1 px-2 py-1 rounded hover:bg-ink-100 dark:hover:bg-ink-800 transition"
        title={`${users.length} 人在線`}
        aria-label={`${users.length} 人在線`}
      >
        <span className="w-2 h-2 rounded-full bg-emerald-500 eink:bg-black" />
        <span className="text-[11px] tabular-nums text-ink-500 dark:text-ink-400">
          {users.length}
        </span>
      </button>

      {/* lg 起:完整頭像列 */}
      <button
        onClick={() => setOpen((v) => !v)}
        className="hidden lg:flex items-center -space-x-1.5 px-1 py-1 rounded hover:bg-ink-100 dark:hover:bg-ink-800 transition"
        title={`${users.length} 人在線`}
      >
        {visible.map((u) => (
          <span
            key={u.email}
            className="relative ring-2 ring-white dark:ring-ink-900 rounded-full"
          >
            <Avatar
              email={u.email}
              avatarKey={u.avatar_key}
              name={u.display_name}
              size={24}
            />
            {/* 純色小圓點在 1-bit 下會被洗白、整個消失 —— 撈回實心黑
                (外圈的 ring-white 保留,黑點在任何底色上都看得見)。 */}
            <span className="absolute -bottom-0 -right-0 w-2 h-2 bg-emerald-500 eink:bg-black rounded-full ring-1 ring-white dark:ring-ink-900" />
          </span>
        ))}
        {more > 0 && (
          <span className="ml-2 text-[11px] text-ink-500 dark:text-ink-400">
            +{more}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-9 w-56 bg-white dark:bg-ink-800 border border-ink-200 dark:border-ink-700 rounded shadow-lg z-30 py-1">
          <div className="px-3 py-2 text-[11px] uppercase tracking-wider text-ink-500 dark:text-ink-400 border-b border-ink-100 dark:border-ink-700">
            {users.length} 人在線
          </div>
          {users.map((u) => (
            <div key={u.email} className="px-3 py-1.5 flex items-center gap-2 text-sm">
              <Avatar email={u.email} avatarKey={u.avatar_key} name={u.display_name} size={20} />
              <span className="text-ink-800 dark:text-ink-200">{u.display_name}</span>
              <span className="ml-auto w-1.5 h-1.5 bg-emerald-500 eink:bg-black rounded-full" />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

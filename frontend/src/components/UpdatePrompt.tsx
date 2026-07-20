import { useEffect, useState } from 'react';
import { onNeedRefresh, applyUpdate } from '../lib/pwa';

/**
 * Bottom strip offering the reload once a new service worker is waiting.
 *
 * The reload is deliberately manual. Auto-`skipWaiting()` would hand the open
 * tab to the new worker while its DOM still references the *old* build's
 * hashed chunks — and Pages only keeps the newest deploy, so the next lazy
 * route (講義) would 404 into a blank screen. A full reload swaps everything
 * at once.
 */
export function UpdatePrompt() {
  const [show, setShow] = useState(false);

  useEffect(() => onNeedRefresh(setShow), []);

  if (!show) return null;

  return (
    <div
      role="status"
      className="fixed inset-x-0 bottom-[var(--bottom-nav-h)] z-30 mx-auto max-w-md m-3 flex items-center gap-3 rounded-lg border border-ink-200 dark:border-ink-700 bg-white dark:bg-ink-800 px-4 py-2.5 shadow-paper"
    >
      <span className="text-sm text-ink-700 dark:text-ink-200">有新版本可用</span>
      <button
        onClick={applyUpdate}
        className="ml-auto rounded bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent-dark"
      >
        重新載入
      </button>
      <button
        onClick={() => setShow(false)}
        className="rounded px-2 py-1.5 text-sm text-ink-500 dark:text-ink-400 hover:text-ink-800 dark:hover:text-ink-100"
      >
        稍後
      </button>
    </div>
  );
}

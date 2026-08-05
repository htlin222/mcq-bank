import { useEffect, useState } from 'react';
import { onNeedRefresh, applyUpdate } from '../lib/pwa';
import { formatDeployedAt } from '../lib/deployTime';

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
  const [version, setVersion] = useState<{
    buildTime?: string;
    buildTimeIso?: string;
  } | null>(null);
  // 相對時間會走針,而這條提示可以在畫面上掛很久(不按就不會消失)。每分鐘
  // 推一次 now 讓它重算,免得停在「剛剛」到天荒地老。存的是原始資料、算在
  // render 裡 —— 綁在 fetch 那個 effect 上會變成每分鐘重打一次 version.json。
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => onNeedRefresh(setShow), []);

  // When the prompt appears, ask the network — *through*, not from, the current
  // service worker — for the latest deployed build time, so the user sees how
  // fresh the waiting version is. /version.json is deliberately outside the SW
  // precache glob, so this passes to the origin and returns the newest deploy.
  // Best-effort: an expired Access session answers with a login redirect, not
  // JSON, so we guard on content-type and simply omit the stamp if anything's off.
  useEffect(() => {
    if (!show) return;
    let alive = true;
    fetch(`/version.json?t=${Date.now()}`, { cache: 'no-store' })
      .then((res) => {
        const ct = res.headers.get('content-type') || '';
        if (!res.ok || res.redirected || !ct.includes('json')) return null;
        return res.json() as Promise<{ buildTime?: string; buildTimeIso?: string }>;
      })
      .then((data) => {
        if (alive) setVersion(data);
      })
      .catch(() => {
        /* offline or blocked — leave the stamp out */
      });
    return () => {
      alive = false;
    };
  }, [show]);

  useEffect(() => {
    if (!show) return;
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, [show]);

  if (!show) return null;

  const deployedAt = formatDeployedAt(version, now);

  return (
    <div
      role="status"
      className="fixed inset-x-0 bottom-[var(--bottom-nav-h)] z-30 mx-auto max-w-md m-3 flex items-center gap-3 rounded-lg border border-ink-200 dark:border-ink-700 bg-white dark:bg-ink-800 px-4 py-2.5 shadow-paper"
    >
      <div className="min-w-0">
        <span className="text-sm text-ink-700 dark:text-ink-200">有新版本可用</span>
        {deployedAt && (
          <span className="block text-xs text-ink-400 dark:text-ink-500 tabular-nums">
            部署於 {deployedAt}
          </span>
        )}
      </div>
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

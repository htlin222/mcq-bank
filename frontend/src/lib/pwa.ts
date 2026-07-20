// Service-worker registration and the app side of the SW ↔ page protocol.
// Imported for side effects from main.tsx, before React mounts.
//
// No-ops in `vite dev` (devOptions.enabled = false in vite.config.ts) and in
// browsers without SW support — every call site tolerates that.

import { registerSW } from 'virtual:pwa-register';

// Re-check for a new deploy this often, so a tab left open for days still
// picks up releases. Also re-checked whenever the tab returns to the
// foreground, which is the common case on a phone.
const UPDATE_INTERVAL_MS = 30 * 60 * 1000;

type Listener = (needRefresh: boolean) => void;

let needRefresh = false;
const listeners = new Set<Listener>();

function setNeedRefresh(v: boolean) {
  needRefresh = v;
  for (const l of listeners) l(v);
}

/** Subscribe to "a new version is waiting". Returns an unsubscribe fn. */
export function onNeedRefresh(listener: Listener): () => void {
  listeners.add(listener);
  listener(needRefresh);
  return () => listeners.delete(listener);
}

/**
 * Accept the waiting worker: it receives SKIP_WAITING, takes over, and the
 * page does a full reload so old and new chunks never mix.
 *
 * `updateSW(true)` only reloads if a worker is actually waiting. It can fail
 * that precondition for reasons the page can't see — the waiting worker was
 * replaced by a newer deploy, the install errored, the registration went
 * stale — and then it resolves having done nothing at all. A button that
 * silently does nothing is worse than a slightly redundant reload, so if the
 * page is still here shortly after, reload it directly.
 */
export function applyUpdate(): void {
  void updateSW(true);
  // Unconditional, because every way this can go wants a reload: if the SW
  // path works it reloads first and this never runs; if it no-ops, or hangs,
  // this is the reload the user asked for. Worst case it duplicates one.
  window.setTimeout(() => window.location.reload(), 1500);
}

const updateSW = registerSW({
  immediate: true,
  onNeedRefresh: () => setNeedRefresh(true),
  onRegisteredSW(_url, registration) {
    if (!registration) return;
    setInterval(() => void registration.update(), UPDATE_INTERVAL_MS);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void registration.update();
    });
  },
});

// The SW tells us when a response smelled like the Cloudflare Access login
// page. Recovering needs a *full* navigation (not react-router) so the browser
// follows Access's 302 and runs the OTP flow. Guarded against loops: if we are
// already sitting on "/", a reload would just bounce forever.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (event) => {
    if ((event.data as { type?: string } | null)?.type !== 'auth-required') return;
    if (window.location.pathname === '/') return;
    window.location.assign('/');
  });
}

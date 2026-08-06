// Cacheability guards for the service worker (frontend/src/sw.ts).
//
// Kept here — outside sw.ts — so they can be unit tested under `node --test`
// without a ServiceWorkerGlobalScope, and so `pnpm test` picks them up via
// the frontend/src/lib/**/*.test.ts glob. Pure functions only: no imports,
// no globals beyond Response/URL.
//
// ---------------------------------------------------------------------------
// Why this exists
//
// When a Cloudflare Access session expires, the *edge* answers with a 302 to
// <team>.cloudflareaccess.com — the Worker is never reached (worker/lib/auth.ts
// always replies 401 JSON instead). fetch() follows redirects by default, so
// the service worker receives:
//
//     res.status     === 200
//     res.ok         === true          <-- status tells you nothing
//     res.redirected === true
//     res.url          host is *.cloudflareaccess.com
//     content-type     text/html
//
// Cache that and the user gets a cached login page on every subsequent load,
// served by a SW that never touches the network again. It cannot self-heal.
// Workbox's built-in `cacheableResponse` plugin only inspects status, so it
// cannot catch this; hence the hand-written `cacheWillUpdate` in sw.ts.
// ---------------------------------------------------------------------------

/**
 * True when a response is (or might be) Cloudflare Access asking for a login
 * rather than our own API answering. Errs on the side of true.
 */
export function isAuthRedirect(
  res: Response | undefined,
  selfOrigin: string
): boolean {
  if (!res) return true;
  // `redirect: 'manual'` responses — no body, no headers, nothing readable.
  if (res.type === 'opaqueredirect') return true;
  if (res.redirected) return true;
  if (res.status === 401 || res.status === 403) return true;
  // A response constructed in-memory has url === ''; that is not cross-origin.
  if (res.url) {
    try {
      if (new URL(res.url).origin !== selfOrigin) return true;
    } catch {
      return true; // unparseable URL — treat as hostile
    }
  }
  return false;
}

/**
 * True when a response body is safe to persist in a runtime cache. Requires
 * a real, same-origin, successful JSON answer — an HTML body is by definition
 * not one of our API responses.
 */
export function isCacheableApiResponse(
  res: Response | undefined,
  selfOrigin: string
): boolean {
  if (!res) return false;
  if (isAuthRedirect(res, selfOrigin)) return false;
  if (!res.ok) return false;
  const ct = res.headers.get('content-type') || '';
  return ct.toLowerCase().includes('application/json');
}

// Allowlist, not blocklist: an endpoint added tomorrow is not cached until
// someone deliberately lists it here. Everything below is a GET that returns
// shared, slow-moving reading material.
//
// Deliberately excluded, and must stay excluded:
//   /api/me                identity — a cached copy survives logout / user switch
//   /api/notifications*    badges must be live, or notifications never clear
//   /api/chat/*            WebSocket upgrade; not cacheable in any sense
//   /api/exam/*            timers and session state; cached = fake scores
//   /api/review/*, /api/drill/*   FSRS scheduling; cached = stale due queue
//   /api/highlights, /api/state, /api/bookmarks   cross-device sync; cached = false conflicts
//   /api/users             presence / mention roster
//   /pdf/*                 tens of MB per lecture (see plan, non-goal #6)
//   /api/admin/*           新年份匯入精靈。它整個機制就是「本機做了什麼,網頁
//                          幾秒內反映出來」—— 心跳、解析進度、暫存區內容全都
//                          是活的狀態。快取一份「12 秒前」會讓精靈變成謊話,
//                          使用者會對著一個永遠不動的畫面等下去。
//   anything non-GET       handled by method check at the call site
const CACHEABLE_API: RegExp[] = [
  /^\/api\/questions(\?|$)/, // list + filters
  /^\/api\/questions\/_meta\/[^/]+$/, // years / groups / tags / lookup
  /^\/api\/questions\/[^/?]+(\?|$)/, // single question (includes 詳解 payload)
  /^\/api\/questions\/[^/?]+\/(comments|note|videos)(\?|$)/,
  /^\/api\/lectures(\?|$)/,
  // 策展影片:離線腳本才會改動,一天內重跑一次都算頻繁。快取的是清單
  // metadata,播放本身仍需連線。
  /^\/api\/videos\/topics(\/[^/?]+)?(\?|$)/,
];

/** @param pathAndSearch e.g. `/api/questions?year=114` (url.pathname + url.search) */
export function isCacheableApiPath(pathAndSearch: string): boolean {
  return CACHEABLE_API.some((re) => re.test(pathAndSearch));
}

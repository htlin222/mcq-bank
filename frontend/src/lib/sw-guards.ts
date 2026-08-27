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
 * Runtime cache name for allowlisted read-only API GETs.
 *
 * Exported rather than inlined so sw.ts and the page agree on one string — the
 * year prefetcher (lib/yearPrefetch.ts + hooks/useYearPrefetch.ts) counts this
 * cache's keys to decide whether a year is fully available offline.
 *
 * ⚠️ 這段註解原本寫的是「頁面也會寫入這個快取(答題後推一份正確的 payload
 * 進去)」—— **那條路徑已經不存在了**,答題後的就地補寫改成了
 * lib/questionProgress.ts 的 preserveLocalAnswer,而註解留了下來。留著它的代價
 * 不是多幾行字:下一個人會照著它去設計「頁面寫快取」的方案,而那個前提是假的。
 */
export const API_CACHE_NAME = 'api-json-v1';

/**
 * 這個快取的上限。**不是隨手挑的數字,是「大於整個題庫」。**
 *
 * 全部 1100 題以 JSON 計約 4.4 MB,所以 1500 > 1100 之後**驅逐壓力整個消失** ——
 * 不必再區分「使用者刻意拓的一年」與「隨手看過的題目」,因為兩者都放得下。
 * 那一整套驅逐策略(第二個 cache、SW fallback 路由、清除 UI)因此不需要存在。
 * 題庫長到五千題以上時,這個假設才會失效,那時要回頭讀
 * docs/plans/2026-08-27-offline-year-prefetch-design.md。
 */
export const API_CACHE_MAX_ENTRIES = 1500;

/**
 * ⚠️ **原本是 7 天,而那會讓拓好的一年在第 8 天無聲過期** —— 考前兩週拓好,
 * 考當天打開是空的。代價是 NetworkFirst 的 3 秒 timeout 落回快取時,拿到的共筆
 * 詳解可能更舊;但詳解很少改,6 天前的版本跟 60 天前的版本在這件事上沒有量級
 * 差別,而「考當天打不開」有。
 */
export const API_CACHE_MAX_AGE_SECONDS = 90 * 24 * 60 * 60;

/** R2 圖片的 runtime cache。 */
export const IMG_CACHE_NAME = 'img-v1';

/**
 * ⚠️ **原本是 300,而一年的詳解就有 125–259 張圖** —— 也就是說拓第二年會把第一年
 * 的圖**擠掉**,而症狀是「離線看某些題沒圖」,完全不會指向快取容量。
 *
 * 2000 大約是全部 11 年(約 1,700 張)。跟 API 那個上限不同,這個**不**大到讓驅逐
 * 壓力消失得毫無疑問 —— 圖片一張平均 66 KB,2000 張約 132 MB,再往上就不該由我們
 * 單方面替使用者決定了。`purgeOnQuotaError` 仍然開著:配額真的滿了就整批讓掉,
 * 而不是讓瀏覽器把**整個站**的快取清空。
 */
export const IMG_CACHE_MAX_ENTRIES = 2000;

/**
 * 圖片的 key 是 UUID,同一個 URL 的內容永遠不變(所以策略是 CacheFirst)——
 * 也就是說這裡**不存在過期的內容,只存在過期的可用性**。原本的 30 天會讓使用者
 * 特地備好的一年在一個月後靜靜消失,同 API 那個 7 天的坑。
 */
export const IMG_CACHE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

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

/**
 * 同上,但給 `/img/<key>` 用。
 *
 * ⚠️ **這支存在的理由是一個實際的 bug:圖片快取從 PWA 上線以來一直是空轉的。**
 * `/img/*` 那條 CacheFirst 路由跟 API 共用同一個 guard,而
 * `isCacheableApiResponse` 要求 `content-type` 含 `application/json` ——
 * 圖片是 `image/webp`,於是 `cacheWillUpdate` 每次都回 null,一張都沒存進去。
 * 2026-08-27 實測:頁面上有兩張 `/img/` 圖、直接 fetch 回 200 `image/png`,
 * 而 `caches.keys()` 裡**連 `img-v1` 都不存在**。
 *
 * 症狀是「離線看詳解沒有圖」—— 而那跟「圖片本來就沒預載」長得一模一樣,所以
 * 它可以活很久。
 *
 * **防 Access 302 的那一層一行都不能少**:過期的 session 換來的是
 * `text/html` 的登入頁,用 CacheFirst 存下來的話,那張圖的位置會永遠是一頁 HTML。
 */
export function isCacheableImageResponse(
  res: Response | undefined,
  selfOrigin: string
): boolean {
  if (!res) return false;
  if (isAuthRedirect(res, selfOrigin)) return false;
  if (!res.ok) return false;
  const ct = res.headers.get('content-type') || '';
  return ct.toLowerCase().startsWith('image/');
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

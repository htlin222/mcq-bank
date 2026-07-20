# PWA 與離線閱讀 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 讓 hema-2026 可以「加到主畫面」當 app 開,並在通勤／地下鐵無訊號時仍能讀已瀏覽過的題目與詳解。第一版只做**離線讀**;離線作答只提供一個最小、冪等的送出佇列。

**Architecture:** Vite build 產出 app shell(index.html + hashed `assets/*`)由 workbox precache;`/api/*` GET 走 runtime cache(白名單制);`/img/*` 走 CacheFirst;`/pdf/*` 一律不快取。整個設計的核心限制是 **Cloudflare Access 會把過期 session 的請求 302 到登入頁**,service worker 必須辨識並拒絕快取這種回應——見下方專章。

**Tech Stack:** `vite-plugin-pwa`(`strategies: 'injectManifest'`)+ `workbox-*` runtime library,SW 原始碼自己寫在 `frontend/src/sw.ts`。manifest 由 `config.toml` 的 `[brand]` 產生。icons 用 Python + Pillow 產生(沿用 `scripts/gen-og-image.py` 的 toolchain)。無新增付費服務。

---

## 現況(已逐一確認,勿臆測)

- **完全沒有 PWA 基礎建設。** `frontend/public/` 只有 `_headers`、`favicon.svg`、`manual.html`(40 KB)、`og-image.png`(72 KB)四個檔 —— **沒有 manifest、沒有 service worker、沒有 icons 目錄**;`frontend/package.json:12-59` 也**沒有** `vite-plugin-pwa` / `workbox-*`。
- `frontend/vite.config.ts:107-137` — plugins 只有 `react()` 與 `appConfigPlugin()`;`build.outDir='dist'`、**`build.sourcemap = true`**(`:136`,dist 會有 `.map`,不可 precache)。
- `frontend/vite.config.ts:65-105` — `appConfigPlugin` 把 `config.toml` 注入成 `__APP_CONFIG__`(`:86`)並替換 `%CONFIG_*%`(`:97-103`)。**檔案頂端的 `bootConfig`(`:77`)可直接餵給 PWA manifest,不需另開設定來源。**
- `frontend/index.html:5-7` — 已有 favicon link 與 `<meta name="theme-color" content="#ffffff">`(**寫死白色,要改**);沒有 manifest link、沒有 apple-touch-icon。
- `frontend/public/_headers:12-18` — CSP 的 `worker-src 'self' blob:` 已允許同源 SW,**CSP 不需要改**。
- **pdfium wasm 不在 dist 內** — `_headers:9` 註明 wasm 與 CJK 字型是 runtime 從 `cdn.jsdelivr.net` 抓;`frontend/src/App.tsx:57-59` 只 lazy 了 `Lectures`/`LectureReader` 的 JS chunk。→ **workbox precache 吃不到 wasm**,但仍要 `globIgnores` 排掉 lecture chunk、`manual.html`、`og-image.png`。
- `frontend/src/lib/api.ts:28-40` — `credentials: 'include'`;body 當文字讀再 `JSON.parse`,失敗就把純文字塞進 `data`(`:37`)。302 被 fetch 自動跟隨後 `res.ok === true`,**登入頁 HTML 現在會被當成成功資料回傳** —— 既有隱性弱點,SW 上線會放大,Task 3.1 一併修。
- `worker/lib/auth.ts:49-82` — 無 Access header/cookie 回 **401 JSON**(`:60`),驗證失敗也是 401 JSON(`:80`)。**302 是 Cloudflare 邊緣做的,不是 Worker** —— 只有未 bypass 的路徑會 302。
- `scripts/setup-public-bypass.sh:41-51` — 現有 bypass:`/og-image.png`、`/favicon.svg`、`/assets/*`、`/api/me`、`/api/mcq/*`、`/`。收尾驗證(`:127-130`)明寫 `/api/health` **仍應 302**,證明 `/` 是**精確路徑**而非前綴萬用 → `/manifest.webmanifest`、`/sw.js`、`/icons/*` **必須新增**。
- `worker/index.ts:75-77` — `/api/*`、`/img/*`、`/pdf/*` 全掛 `authMiddleware`。
- `worker/routes/review.ts:136-174` — `POST /api/review/answer` 每次 `times_seen = times_seen + 1`(`:111-120`)、`confidence_events` 純 INSERT(`:164-171`),**非冪等**。反之 `worker/routes/exam.ts:215` 寫的 `exam_answers` PK 是 `(session_id, question_id)`(`migrations/0001_initial_schema.sql:118-125`),**天然冪等**。
- 配色來源 `frontend/tailwind.config.js:9`(`ink-50 = #f7f5f2`)、`:21`(`accent.DEFAULT = #a8442a`);品牌字串 `config.toml:35-45` `[brand]`(`short_name` / `long_title` / `subtitle`)——**manifest 一律讀這裡,禁止 hard-code**。

---

## 非目標(第一版明確不做)

1. **不做離線作答的完整同步。** Milestone 5 的送出佇列只涵蓋 `POST /api/review/answer` 這一條路徑,且需使用者在恢復連線時仍開著 app。exam(`/api/exam/*`)因為有計時與 session 生命週期,**離線一律禁止進入**。
2. **不做離線編輯**(詳解 / 留言 / 筆記 / 畫記)。詳解有悲觀鎖(`editing_by`/`editing_until`),離線寫入無法取得鎖,一定會製造衝突。離線時這些 UI 一律 disable。
3. **不做背景同步**(Background Sync API / Periodic Sync)。Safari iOS 不支援,而主要使用情境正是 iPhone 加到主畫面。改用「回前景時 flush」。
4. **不做推播通知。** 通知仍是既有的「下次載入看到 badge」語意。
5. **不預先快取整個題庫。** 只快取「使用者實際瀏覽過」的題目。1000 題全下載會炸掉手機儲存也浪費 D1 讀取。
6. **不快取 `/pdf/*` 講義。** 單檔數十 MB,自動快取會塞爆配額。若之後要做,做成使用者主動點「下載此講義離線看」的顯式動作。
7. **不改 Zero Trust 邊界。** R2 圖片一律經 worker proxy,不改公開 bucket。

---

## 技術選型:`vite-plugin-pwa` vs 手寫 SW

| | `vite-plugin-pwa`(generateSW) | **`vite-plugin-pwa`(injectManifest)← 建議** | 純手寫 SW |
| --- | --- | --- | --- |
| precache manifest | 自動,含 hash revision | 自動,含 hash revision | 要自己維護,**每次改 chunk 名都會漏** |
| Access 守門邏輯 | 只能用內建 plugin,**無法判 `res.redirected`** | 自己寫 `sw.ts`,完全可控 | 完全可控 |
| navigation 策略 | `navigateFallback` 預設 cache-first → **踩本計畫最大的雷** | 自己寫 `NetworkOnly + catchHandler` | 自己寫 |
| 更新提示 | `virtual:pwa-register` 現成 | 同左 | 要自己實作 |
| 額外套件 | 1 個 devDep | 1 個 devDep + workbox runtime | 0 |

**選 `injectManifest`。** 理由:(a) Vite 產出的 hashed chunk 名每次 build 都變,手維護 precache 清單必然出錯;(b) 但 `generateSW` 的預設 navigation fallback 正好會製造「快取住 Access 登入頁」的災難,所以 SW 本體必須自己寫。`injectManifest` 是唯一同時滿足兩者的選項。

**wasm 會不會被 precache 吃進去?** 不會 —— pdfium wasm 與 CJK 字型是 runtime 從 `cdn.jsdelivr.net` 抓的(`frontend/public/_headers:9`),不在 `dist/`。但 `dist/` 內仍有 EmbedPDF 的 JS lazy chunk、`sourcemap: true` 產生的 `.map`(`vite.config.ts:136`)、`manual.html`(40 KB)、`og-image.png`(72 KB),都要靠 `globIgnores` + `maximumFileSizeToCacheInBytes` 排除,否則首次安裝會下載數 MB。

---

## Cloudflare Access 與 Service Worker 的互動(本計畫最危險的部分)

### 失效模式

CF Access session 過期時,對**未 bypass**的路徑,Cloudflare 邊緣回 `302` → `<team>.cloudflareaccess.com/…`。`fetch()` 預設 `redirect: 'follow'`,所以 SW 拿到的是:

- `res.status === 200`
- `res.redirected === true`
- `res.url` 的 host 是 `*.cloudflareaccess.com`
- `Content-Type: text/html`

如果 SW 把這個回應寫進 cache,使用者下次開 app 會拿到**快取版的登入頁**,而且因為 SW 每次都命中快取、永遠不再打網路,**它無法自我修復**。這是 PWA 最經典的「使用者永久卡死」災難。

### 三道防線

**防線 1 — 回應守門(SW 內,必做)。** 寫入 cache 前一律過 `frontend/src/sw-guards.ts` 的純函式(實作見 Task 2.1):`isAuthRedirect` 判 `res.type === 'opaqueredirect'` / `res.redirected` / `res.url` 跨源 / 401 / 403;`isCacheableApiResponse` 再加上 `res.ok` 與 `content-type` 必須是 `application/json`。**workbox 內建的 `cacheableResponse` plugin 只看 status,看不出 `redirected`**,所以一定要自己寫 `cacheWillUpdate`。

**防線 2 — navigation 不走快取優先。** 預設的 `navigateFallback`(workbox `createHandlerBoundToURL`)會**永遠**用 precache 的 `index.html` 回應導覽,session 過期的使用者將永遠看不到 Access 登入流程。改成 `NavigationRoute(NetworkOnly)` + `setCatchHandler` → precache 的 `index.html`:線上 → 瀏覽器照常拿到 302 完成 Access 導向;離線 → 網路失敗 → catch → 吐 precached shell。兩邊都對。

**防線 3 — 前端偵測 + 完整導向。** SW 偵測到 auth redirect 時 `postMessage({ type: 'auth-required' })` 給所有 client;client 收到就 `window.location.assign('/')`(**完整導覽,不是 SPA 導航**),讓瀏覽器走 Access 的 302。同樣邏輯加進 `frontend/src/lib/api.ts` 當第二層網(SW 不在時也要對)。

### 必須新增到 bypass 清單的路徑

| 路徑 | 為什麼 |
| --- | --- |
| `/manifest.webmanifest` | 瀏覽器安裝時可能以 `credentials: omit` 抓取;拿到 HTML 會讓安裝提示消失 |
| `/sw.js` | SW **更新檢查**由瀏覽器自行發起。若這次剛好 session 過期而拿到 HTML,瀏覽器會因 MIME 不是 JS 而讓更新失敗,舊 SW 永遠留著 |
| `/icons/*` | 主畫面圖示、splash;與 favicon 同性質(`setup-public-bypass.sh:43` 已 bypass favicon) |

已 bypass 的 `/assets/*`(`setup-public-bypass.sh:44`)剛好覆蓋所有 hashed chunk 與 CSS,precache 不會踩雷。

**這樣公開了什麼?** `sw.js` 只含 precache manifest(檔名 + hash),那些檔案本來就在已公開的 `/assets/*` 下;manifest 與 icons 只含品牌名與圖示,landing page 本來就公開。**沒有新增資料外洩面。**

---

## 跨切面約定

- 品牌字串走 `config.toml` `[brand]`,由 `frontend/vite.config.ts` 既有的 `bootConfig` 供給;禁止 hard-code。
- 顏色取 `frontend/tailwind.config.js`:`theme_color = #a8442a`(accent)、`background_color = #f7f5f2`(ink-50)。
- SW 內任何「要不要快取」的判斷都抽成 `frontend/src/sw-guards.ts` 的純函式,配 `frontend/src/sw-guards.test.ts`(`node:test` + `node:assert/strict`),先寫失敗測試。
- 每個 task 獨立 commit。

---

## Milestone 1 — 可安裝(manifest + icons),先不裝 SW

刻意把「可安裝」和「離線」拆開:M1 上線後即使 M2 出包,回滾也只是刪一個 link tag。

### Task 1.1: 產生 PWA icons

**Files:**
- Create: `scripts/gen-pwa-icons.py`
- Create: `frontend/public/icons/{icon-192.png,icon-512.png,icon-512-maskable.png,apple-touch-icon-180.png}`

**Step 1:** 仿 `scripts/gen-og-image.py:1-13` 的體例(`tomllib` 讀 config、docstring 寫 `uv run --with …`)。SVG → PNG 用 `cairosvg`,合成補邊用 `Pillow`:

```python
# uv run --with pillow --with cairosvg python3 scripts/gen-pwa-icons.py
SRC = ROOT / "frontend/public/favicon.svg"
OUT = ROOT / "frontend/public/icons"
INK_50, ACCENT = "#f7f5f2", "#a8442a"   # tailwind.config.js:9 / :21
# maskable：圖形縮到 80% 置中，四周留 safe-zone，底色 INK_50
```

**Step 2:** 產 192、512、512-maskable(安全區)、180(apple-touch,**不可透明**,iOS 不支援)。

**Step 3:** 驗證 —— 跑一次腳本,再用 Pillow 印出四檔尺寸確認。

**Step 4:** commit `feat(pwa): generate app icons from favicon.svg via config-driven script`。

### Task 1.2: 安裝 vite-plugin-pwa 並輸出 manifest

**Files:**
- Modify: `frontend/package.json`
- Modify: `frontend/vite.config.ts`
- Modify: `frontend/index.html`

**Step 1:** `cd frontend && pnpm add -D vite-plugin-pwa`(workbox 由它帶入)。

**Step 2:** `vite.config.ts` 匯入並加入 plugin。**注意重用檔案頂端既有的 `bootConfig`(`:77`),不要另讀 config.toml:**

```ts
import { VitePWA } from 'vite-plugin-pwa';

// 在 plugins 陣列（:108）追加：
VitePWA({
  strategies: 'injectManifest',
  srcDir: 'src',
  filename: 'sw.ts',
  registerType: 'prompt',        // 不自動 skipWaiting，見 Milestone 4
  injectRegister: null,          // 註冊碼寫在 app 內，避免多一個未 bypass 的 /registerSW.js
  manifest: {
    name: bootConfig.brand.long_title,
    short_name: bootConfig.brand.short_name,
    description: bootConfig.brand.subtitle,
    lang: 'zh-TW',
    start_url: '/home',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#f7f5f2',  // ink-50
    theme_color: '#a8442a',       // accent.DEFAULT
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/icons/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  },
  injectManifest: {
    // sourcemap: true（:136）→ 一定要排掉 .map；大檔與 lecture chunk 也排掉
    globPatterns: ['**/*.{js,css,html,svg,woff2}'],
    globIgnores: ['**/*.map', 'manual.html', 'og-image.png', '**/*[Ll]ecture*'],
    maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
  },
  devOptions: { enabled: false },  // 本地預設關閉，避免 HMR 被舊 SW 綁架
}),
```

**Step 3:** `frontend/index.html` 補 head(`:5-7` 附近):
```html
<link rel="manifest" href="/manifest.webmanifest" />
<link rel="apple-touch-icon" href="/icons/apple-touch-icon-180.png" />
<meta name="apple-mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-status-bar-style" content="default" />
```
並把 `:7` 的 `<meta name="theme-color" content="#ffffff" />` 改成 `#a8442a`。

**Step 4:** 此時 `frontend/src/sw.ts` 還不存在,build 會失敗 —— 先建一個最小佔位(`self.skipWaiting` 都不做,只 `precacheAndRoute(self.__WB_MANIFEST)`),Task 2.2 再補完。

**Step 5:** 驗證
```bash
cd frontend && pnpm build
cat dist/manifest.webmanifest | python3 -m json.tool   # name 應為 config.toml 的 long_title
ls dist/sw.js
```

**Step 6:** commit `feat(pwa): add vite-plugin-pwa with config-driven manifest`。

### Task 1.3: 把 manifest / sw.js / icons 加入 Access bypass

**Files:**
- Modify: `scripts/setup-public-bypass.sh:41-51`

**Step 1:** 在 `PATHS` 陣列中、`"/|${SLUG} public · landing"` 這筆**之前**插入(該行 `:40` 註明「Order matters」):

```bash
  # PWA：安裝與 SW 更新檢查可能在沒有 Access session 的情況下發生。
  # 若拿到 302→登入頁 HTML，安裝提示會消失、SW 更新會因 MIME 錯誤而永久失敗。
  # 內容只有品牌字串、圖示與 precache 檔名（檔案本身已在 /assets/* bypass 下）。
  "/manifest.webmanifest|${SLUG} public · pwa-manifest"
  "/sw.js|${SLUG} public · pwa-sw"
  "/icons/*|${SLUG} public · pwa-icons"
```

**Step 2:** `./scripts/setup-public-bypass.sh --dry-run` → 應列出三筆 would create,既有六筆 skip。

**Step 3:** 套用後驗證(注意:必須在 Pages 部署過新版之後才會有 200):
```bash
H=$(node scripts/lib/cfg.mjs public.host)
curl -sI "https://$H/manifest.webmanifest" | head -3   # 200 + application/manifest+json
curl -sI "https://$H/sw.js" | head -3                  # 200 + javascript
curl -sI "https://$H/api/health" | head -3             # 仍應 302（沒有被誤放行）
```

**Step 4:** commit `feat(access): bypass manifest, sw.js and icons for PWA install`。

---

## Milestone 2 — Service Worker(Access-safe 的離線讀)

### Task 2.1: 快取守門純函式(TDD)

**Files:**
- Create: `frontend/src/sw-guards.ts`
- Test: `frontend/src/sw-guards.test.ts`

**Step 1 — 失敗測試** `frontend/src/sw-guards.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isCacheableApiResponse, isCacheableApiPath } from './sw-guards.ts';

const ORIGIN = 'https://example.com';
const json = () => new Response('{}', { headers: { 'content-type': 'application/json' } });

test('跟隨過 302 的回應一律不快取', () => {
  const res = json();
  Object.defineProperty(res, 'redirected', { value: true });
  assert.equal(isCacheableApiResponse(res, ORIGIN), false);
});

test('HTML 回應（Access 登入頁）不快取', () => {
  const res = new Response('<html>', { headers: { 'content-type': 'text/html' } });
  assert.equal(isCacheableApiResponse(res, ORIGIN), false);
});
test('正常 JSON 可快取', () => assert.equal(isCacheableApiResponse(json(), ORIGIN), true));
test('敏感/易變端點不進 runtime cache', () => {
  assert.equal(isCacheableApiPath('/api/questions/114-001'), true);
  assert.equal(isCacheableApiPath('/api/me'), false);
  assert.equal(isCacheableApiPath('/api/notifications/unread-count'), false);
  assert.equal(isCacheableApiPath('/api/chat/ws'), false);
});
```

**Step 2:** `cd frontend && node --test src/sw-guards.test.ts` → FAIL。

**Step 3 — 實作** `isAuthRedirect`(`res.type === 'opaqueredirect'` ‖ `res.redirected` ‖ `new URL(res.url).origin !== selfOrigin` ‖ status 401/403)、`isCacheableApiResponse`(前者為 false 且 `res.ok` 且 `content-type` 含 `application/json`),外加**白名單**(預設不快取,新端點自動安全):

```ts
const CACHEABLE_API = [
  /^\/api\/questions\/[^/]+$/,               // 單題（含詳解 payload）
  /^\/api\/questions\/[^/]+\/(comments|note)$/,
  /^\/api\/questions\?/,                     // 列表 / 篩選
  /^\/api\/lectures$/,
];
export const isCacheableApiPath = (p: string) => CACHEABLE_API.some((re) => re.test(p));
```

**明確不可快取清單**(即使將來擴充白名單也不得加入):

| 端點 | 原因 |
| --- | --- |
| `/api/me` | 身分狀態;快取會讓登出/換人後仍顯示舊使用者 |
| `/api/notifications*` | badge 必須即時;快取等於通知永遠不消失 |
| `/api/chat/*`(含 `/ws`) | WebSocket 無法快取,`worker/routes/chat.ts:14` |
| `/api/exam/*` | 計時與 session 狀態,快取會造成假分數 |
| `/api/review/*`、`/api/drill/*` | 排程(FSRS)與作答結果,快取會回放過期的 due 清單 |
| `/api/state`、`/api/highlights` | 跨裝置同步資料,快取會製造假衝突 |
| 所有非 GET | 一律 NetworkOnly |
| `/pdf/*` | 大檔,見非目標 #6 |
| `/img/*` 之外的 R2 | 無 |

**Step 4:** `node --test src/sw-guards.test.ts` → PASS。commit `feat(pwa): cacheability guards rejecting Access redirect responses`。

### Task 2.2: 實作 sw.ts

**Files:**
- Modify: `frontend/src/sw.ts`(Task 1.2 的佔位)

**Step 1:** app shell precache + navigation 策略(**注意用 `NetworkOnly` + catchHandler,不是 `createHandlerBoundToURL`**):

```ts
/// <reference lib="webworker" />
import { precacheAndRoute, matchPrecache } from 'workbox-precaching';
import { registerRoute, setCatchHandler, NavigationRoute } from 'workbox-routing';
import { NetworkOnly, NetworkFirst, CacheFirst, StaleWhileRevalidate } from 'workbox-strategies';
import { ExpirationPlugin } from 'workbox-expiration';
import { isCacheableApiResponse, isCacheableApiPath, isAuthRedirect } from './sw-guards';

declare const self: ServiceWorkerGlobalScope;
const ORIGIN = self.location.origin;

precacheAndRoute(self.__WB_MANIFEST);

// 導覽：線上一律走網路（讓 CF Access 的 302 能正常發生）；離線才退回 shell。
registerRoute(new NavigationRoute(new NetworkOnly()));
setCatchHandler(async ({ request }) =>
  request.mode === 'navigate'
    ? (await matchPrecache('/index.html')) ?? Response.error()
    : Response.error()
);
```

**Step 2:** 共用的 `authGuard` plugin —— 這是整份計畫的關鍵五行:

```ts
const authGuard = {
  cacheWillUpdate: async ({ response }) =>
    isCacheableApiResponse(response, ORIGIN) ? response : null,
  fetchDidSucceed: async ({ response }) => {
    if (isAuthRedirect(response, ORIGIN))
      for (const c of await self.clients.matchAll({ type: 'window' }))
        c.postMessage({ type: 'auth-required' });
    return response;
  },
};
```

**Step 3:** 三條 runtime route(全部掛 `authGuard`):

```ts
// API GET 白名單 → NetworkFirst，3 秒 timeout 讓弱訊號快速退回快取
registerRoute(({ url, request, sameOrigin }) =>
    sameOrigin && request.method === 'GET' && isCacheableApiPath(url.pathname + url.search),
  new NetworkFirst({ cacheName: 'api-json-v1', networkTimeoutSeconds: 3,
    plugins: [authGuard, new ExpirationPlugin({ maxEntries: 400, maxAgeSeconds: 7 * 86400 })] }));

// R2 圖片：key 帶 UUID，內容不可變 → CacheFirst
registerRoute(({ url, sameOrigin }) => sameOrigin && url.pathname.startsWith('/img/'),
  new CacheFirst({ cacheName: 'img-v1', plugins: [authGuard,
    new ExpirationPlugin({ maxEntries: 300, maxAgeSeconds: 30 * 86400, purgeOnQuotaError: true })] }));

// 講義大檔：明確不快取
registerRoute(({ url, sameOrigin }) => sameOrigin && url.pathname.startsWith('/pdf/'), new NetworkOnly());
```

**Step 4:** Google Fonts(`index.html:8-10` 的跨源 stylesheet + woff2)用 `StaleWhileRevalidate`,`cacheName: 'gfonts-v1'`。跨源回應是 opaque,不受 `authGuard` 影響。

**Step 5:** **不呼叫 `self.skipWaiting()`**,改成聽訊息(見 Milestone 4):
`self.addEventListener('message', (e) => { if (e.data?.type === 'SKIP_WAITING') self.skipWaiting(); });`

**Step 6:** 驗證 `cd frontend && pnpm build && pnpm preview` → DevTools Application 面板 SW 應為 activated,Network 面板重整可見 `(ServiceWorker)` 來源。

**Step 7:** commit `feat(pwa): Access-aware service worker with offline read caching`。

---

## Milestone 3 — App 端整合

### Task 3.1: 註冊 SW + auth-required 處理

**Files:**
- Create: `frontend/src/lib/pwa.ts`
- Modify: `frontend/src/main.tsx`
- Modify: `frontend/src/lib/api.ts`

**Step 1:** `frontend/src/lib/pwa.ts` 用 `virtual:pwa-register`(`registerSW({ immediate: true, onNeedRefresh, onOfflineReady })`),並掛上 SW 訊息監聽:
`navigator.serviceWorker?.addEventListener('message', (e) => { if (e.data?.type === 'auth-required') window.location.assign('/'); });`

**Step 2:** `main.tsx` 在 `createRoot(...).render(...)`(`:8`)之前 `import './lib/pwa'`。

**Step 3:** `api.ts` 的 `request`(`:28-40`)加第二層網 —— 在 `if (!res.ok) throw` **之前**:
```ts
if (res.redirected || new URL(res.url, location.origin).origin !== location.origin) {
  window.location.assign('/');            // 完整導覽，讓 CF Access 接手
  throw new ApiError(401, { error: 'access_session_expired' });
}
```
這也順手修掉 `:37` 「HTML 被當成資料吞下去」的既有問題。

**Step 4:** 本地 `pnpm dev` 走一遍首頁 / 題目頁,確認無 regression(dev 模式 SW 是關的,這步只驗 api.ts 改動)。

**Step 5:** commit `feat(pwa): register SW and force full navigation on Access session expiry`。

### Task 3.2: 離線指示與 disable 寫入 UI

**Files:**
- Create: `frontend/src/hooks/useOnline.ts`
- Modify: 詳解編輯 / 留言 / 上傳 的入口元件(`Editor` 觸發點、`CommentThread`、`ImageUpload`)

**Step 1:** `useOnline` 包 `navigator.onLine` + `online`/`offline` 事件。

**Step 2:** 全域一條細長離線橫幅(ink-100 底、accent 左邊框;不用 toast,避免蓋住閱讀區):「離線中 · 可閱讀已看過的內容,編輯功能暫停」。

**Step 3:** 離線時把「編輯詳解」「送出留言」「上傳圖片」設 `disabled` + tooltip;**不要**讓它們送出後才失敗(詳解的悲觀鎖尤其不能離線嘗試)。DevTools → Network → Offline 手測後 commit `feat(ui): offline banner and write-action lockout`。

---

## Milestone 4 — 更新流程

### Task 4.1: 新版提示

**Files:**
- Create: `frontend/src/components/UpdatePrompt.tsx`
- Modify: `frontend/src/App.tsx`

**Step 1:** `registerType: 'prompt'`(Task 1.2)下,新 SW 進 `waiting` 時 `onNeedRefresh` 會觸發。顯示一條底部橫幅:「有新版本 · 重新載入」。按下 → `updateSW(true)`(內部送 `SKIP_WAITING` 後 reload)。

**Step 2:** **為什麼不自動 `skipWaiting`:** 自動接管會讓「已載入的舊頁面」開始向新版的 hashed chunk 請求 —— 舊 `index.html` 引用的 chunk 檔名在新版已不存在(Pages 只保留最新一版),使用者按下 lazy route 就會白畫面。`registerType: 'prompt'` 讓分頁在使用者同意後整頁 reload,避免新舊混用。

**Step 3:** 加一個「保底」:`registerSW` 每 30 分鐘 `r.update()` 一次,並在 `visibilitychange` 回前景時 `r.update()`,避免長開的分頁永遠停在舊版。

**Step 4:** 驗證:`pnpm build && pnpm preview` → 開頁 → 改一行原始碼 → 重新 build → 回瀏覽器重整一次 → 應出現更新橫幅。

**Step 5:** commit `feat(pwa): prompt-to-reload update flow with periodic update checks`。

---

## Milestone 5 — 最小離線作答佇列(可選,確認 M1-M4 穩定後再做)

**只涵蓋複習模式的 `POST /api/review/answer`。exam 不納入(見非目標 #1)。**

### Task 5.1: 冪等鍵(伺服器端)

**Files:**
- Create: `migrations/00NN_answer_idempotency.sql`(**新增,不改已套用的檔**)
- Modify: `worker/routes/review.ts:136-174`

**Step 1:** migration —— `CREATE TABLE answer_submissions (client_id TEXT PRIMARY KEY, user_email TEXT NOT NULL REFERENCES users(email), question_id TEXT NOT NULL, at INTEGER NOT NULL)` + `idx_as_user(user_email, at DESC)`。

**Step 2:** `POST /api/review/answer` 接受選填 `client_id`。有帶就先 `INSERT … ON CONFLICT(client_id) DO NOTHING`;`meta.changes === 0` 代表**重送**,直接回既有結果、**跳過** `answerProgressOp`(`review.ts:111-120` 的 `times_seen + 1`)與 `confidence_events` INSERT(`:164-171`)。沒帶 `client_id` 就維持現行行為,線上路徑零改變。

**Step 3:** `wrangler d1 migrations apply <db> --local` 後本地手測:同一 `client_id` 送兩次,`SELECT times_seen` 應只 +1。

**Step 4:** commit `feat(review): idempotent answer submission via client_id`。

### Task 5.2: IndexedDB 佇列(前端)

**Files:**
- Create: `frontend/src/lib/outbox.ts` + `frontend/src/lib/outbox.test.ts`

**Step 1:** 極小的 IndexedDB wrapper(單一 store `outbox`,key = `client_id`),不引第三方套件。

**Step 2:** 離線送出時 `enqueue({ client_id: crypto.randomUUID(), question_id, chosen, confidence, at })`,UI 樂觀顯示「已記錄,連線後同步」。

**Step 3:** `flush()` 在 `online` 事件與 `visibilitychange`→visible 時觸發,**逐筆序列送出**(不並發,避免 D1 寫入尖峰);成功或 4xx 就刪除該筆,5xx / 網路錯誤保留待下次。

**Step 4:** 純函式部分(排序、重試判定、上限 200 筆丟最舊)寫測試。commit `feat(pwa): IndexedDB outbox for offline review answers`。

---

## 驗收清單

- [ ] `cd frontend && node --test 'src/**/*.test.ts'` 全綠;`node --test 'worker/**/*.test.ts'` 全綠
- [ ] `cd frontend && pnpm build` 通過;`dist/` 內**沒有** `.map` 進 precache manifest(`grep -c '\.map' dist/sw.js` 應為 0)
- [ ] `dist/manifest.webmanifest` 的 `name` 等於 `config.toml` 的 `brand.long_title`(改 config.toml 重 build 應跟著變)
- [ ] `curl -sI https://<host>/manifest.webmanifest`、`/sw.js`、`/icons/icon-192.png` 皆 200;`/api/health` 仍 302
- [ ] Chrome DevTools → Application → Manifest 無警告;Service Workers 顯示 activated;Cache Storage 出現 `api-json-v1` / `img-v1`
- [ ] Lighthouse(PWA / Best Practices)在 `pnpm preview` 上 installable 檢查通過
- [ ] **飛航模式測試**:線上瀏覽 3 題 → 開飛航 → 從主畫面開 app → 這 3 題與圖片可讀,其他題顯示離線提示,不白畫面
- [ ] **Access 過期測試**(最關鍵):DevTools → Application → Cookies 刪掉 `CF_Authorization` → 重整 → 應被導向 Access 登入頁,**且 Cache Storage 內不得出現任何 `text/html` 的 `/api/*` 項目**
- [ ] iOS Safari 實機「加入主畫面」→ 圖示正確、`display: standalone`(無網址列)、`start_url` 進入 `/home`
- [ ] 部署新版後,已開著的分頁在 30 分鐘內或回前景時出現「有新版本」橫幅

---

## 風險與回滾

**SW 是最容易造成「使用者永久卡死」的技術。** 部署前先確認以下三條逃生路徑都可用。

1. **Kill switch(首選,不需使用者操作)。** 保留一份 `frontend/public/sw-kill.js`;緊急時把它 `cp` 成 `frontend/public/sw.js`(蓋過 build 產物)並重新部署 Pages。內容:
   ```js
   self.addEventListener('install', () => self.skipWaiting());
   self.addEventListener('activate', async () => {
     for (const k of await caches.keys()) await caches.delete(k);
     const rs = await self.registration.unregister();
     const cs = await self.clients.matchAll({ type: 'window' });
     for (const c of cs) c.navigate(c.url);
     return rs;
   });
   ```
   因為瀏覽器每次導覽都會去抓 `/sw.js`(且該路徑已 Access-bypass,不會拿到 HTML),所有使用者會在下次開 app 時自動解除註冊並清空快取。**這就是 Task 1.3 一定要 bypass `/sw.js` 的真正理由。**
   建立這個檔案是 Milestone 2 的**前置條件**,不是事後才寫。
2. **版本回滾。** `wrangler pages deployment list` → 在 dashboard rollback 到上一版。注意:單純 rollback **不會**移除使用者已註冊的 SW —— 必須搭配 kill switch。
3. **使用者自救(最後手段)。** 桌機 DevTools → Application → Storage → Clear site data;iOS Safari 設定 → 清除網站資料;或刪除主畫面圖示重裝。**這是失敗狀態,不是回滾方案。**

其他風險:

- **快取到登入頁** — 由 `sw-guards.ts` 三重判定 + 白名單策略防堵,且有單測。上線後在 Cache Storage 面板實地確認一次。
- **iOS 儲存回收** — Safari 會在長期未使用後清掉 SW 快取。這是預期行為,離線內容消失屬可接受降級。
- **配額爆掉** — `ExpirationPlugin` 有 `maxEntries` 與 `purgeOnQuotaError: true`;`/pdf/*` 明確不快取。
- **dev 模式被舊 SW 綁架** — `devOptions.enabled = false`;若本地曾註冊過,先在 DevTools 勾 "Bypass for network" 或手動 unregister。
- **CSP** — `frontend/public/_headers:18` 的 `worker-src 'self' blob:` 已涵蓋同源 SW,不需變更;若之後收緊 CSP,記得 SW 也是 worker。

---

## 成本

**全部落在 Cloudflare free tier,且淨效果是往下降。**

- SW 與 manifest 都是 Pages 靜態資產,Pages 免費方案不計 request。
- 新增三個 Access bypass application —— Zero Trust 免費方案的 app 數量遠高於目前的 9 個。
- runtime cache 命中會**減少** Worker invocation、D1 讀取與 R2 讀取(`/img/*` CacheFirst 尤其明顯)。
- Milestone 5 新增一張 `answer_submissions` 表,每次作答一列;20 人 × 1000 題規模對 D1 免費額度(5 GB / 5M reads·day)無影響。
- 無新增付費服務、無 Durable Object、無 KV、無 Workers AI 呼叫。

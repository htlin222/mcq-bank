/// <reference lib="webworker" />
//
// Service worker — offline *reading* only.
//
// Compiled by vite-plugin-pwa in `injectManifest` mode (see vite.config.ts);
// `self.__WB_MANIFEST` is replaced at build time with the app-shell file list.
//
// The single constraint that shapes everything here: Cloudflare Access answers
// an expired session with an edge-level 302 to the login page. fetch() follows
// it, so a "successful" 200 may in fact be HTML from another origin. Nothing
// below may cache a response without first passing it through the guards in
// lib/sw-guards.ts. See docs/plans/2026-07-20-pwa-offline.md.

import { precacheAndRoute, matchPrecache } from 'workbox-precaching';
import { registerRoute, setCatchHandler, NavigationRoute } from 'workbox-routing';
import {
  NetworkOnly,
  NetworkFirst,
  CacheFirst,
  StaleWhileRevalidate,
} from 'workbox-strategies';
import { ExpirationPlugin } from 'workbox-expiration';
import {
  isCacheableApiResponse,
  isCacheableApiPath,
  isAuthRedirect,
  API_CACHE_NAME,
  API_CACHE_MAX_ENTRIES,
  API_CACHE_MAX_AGE_SECONDS,
} from './lib/sw-guards';

declare const self: ServiceWorkerGlobalScope;

const ORIGIN = self.location.origin;

// --- app shell -----------------------------------------------------------
precacheAndRoute(self.__WB_MANIFEST);

// Navigation is NetworkOnly on purpose. The generateSW default
// (`navigateFallback` → precached index.html, cache-first) would answer every
// navigation from cache forever, so a user whose Access session expired would
// never see the login redirect and could not recover. Online: the browser gets
// the real response, including CF Access's 302. Offline: the fetch throws and
// the catch handler below serves the shell.
registerRoute(new NavigationRoute(new NetworkOnly()));

setCatchHandler(async ({ request }) => {
  if (request.mode === 'navigate') {
    return (await matchPrecache('/index.html')) ?? Response.error();
  }
  return Response.error();
});

// --- the guard, shared by every caching route ----------------------------
// `cacheWillUpdate` returning null tells workbox to skip the write. Workbox's
// own cacheableResponse plugin only looks at status codes and would happily
// store a 200 that is really the Access login page.
const authGuard = {
  cacheWillUpdate: async ({ response }: { response: Response }) =>
    isCacheableApiResponse(response, ORIGIN) ? response : null,
  fetchDidSucceed: async ({ response }: { response: Response }) => {
    if (isAuthRedirect(response, ORIGIN)) {
      for (const client of await self.clients.matchAll({ type: 'window' })) {
        client.postMessage({ type: 'auth-required' });
      }
    }
    return response;
  },
};

// --- runtime caches ------------------------------------------------------

// Read-only question/lecture JSON, allowlisted in sw-guards.ts. NetworkFirst
// with a short timeout: a flaky signal falls back to the cached copy fast
// instead of hanging on a request that will never complete.
registerRoute(
  ({ url, request, sameOrigin }) =>
    sameOrigin &&
    request.method === 'GET' &&
    isCacheableApiPath(url.pathname + url.search),
  new NetworkFirst({
    cacheName: API_CACHE_NAME,
    networkTimeoutSeconds: 3,
    plugins: [
      authGuard,
      new ExpirationPlugin({
        maxEntries: API_CACHE_MAX_ENTRIES,
        maxAgeSeconds: API_CACHE_MAX_AGE_SECONDS,
      }),
    ],
  })
);

// R2 images proxied by the Worker. Keys are UUIDs, so content never changes
// under a given URL — CacheFirst is safe and saves a Worker invocation.
registerRoute(
  ({ url, request, sameOrigin }) =>
    sameOrigin && request.method === 'GET' && url.pathname.startsWith('/img/'),
  new CacheFirst({
    cacheName: 'img-v1',
    plugins: [
      authGuard,
      new ExpirationPlugin({
        maxEntries: 300,
        maxAgeSeconds: 30 * 24 * 60 * 60,
        purgeOnQuotaError: true,
      }),
    ],
  })
);

// Lecture PDFs are tens of MB each — explicitly never cached.
registerRoute(
  ({ url, sameOrigin }) => sameOrigin && url.pathname.startsWith('/pdf/'),
  new NetworkOnly()
);

// Webfonts from index.html. Cross-origin and opaque, so the auth guard neither
// applies nor is needed (Access never redirects fonts.gstatic.com).
registerRoute(
  ({ url }) =>
    url.origin === 'https://fonts.googleapis.com' ||
    url.origin === 'https://fonts.gstatic.com',
  new StaleWhileRevalidate({
    cacheName: 'gfonts-v1',
    plugins: [
      new ExpirationPlugin({ maxEntries: 30, maxAgeSeconds: 365 * 24 * 60 * 60 }),
    ],
  })
);

// --- update handshake ----------------------------------------------------
// No unconditional skipWaiting: an already-open tab references hashed chunks
// that the new deploy has deleted, so taking over silently turns its lazy
// routes into blank pages. lib/pwa.ts sends this once the user accepts the
// "new version" prompt, and reloads afterwards.
self.addEventListener('message', (event) => {
  if ((event.data as { type?: string } | null)?.type === 'SKIP_WAITING') {
    void self.skipWaiting();
  }
});

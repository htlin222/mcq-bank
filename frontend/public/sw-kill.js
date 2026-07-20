// EMERGENCY KILL SWITCH — not served at this path in normal operation.
//
// If the service worker ever wedges users (a cached Access login page, a
// broken precache, a bad release), recover with:
//
//   cp frontend/public/sw-kill.js frontend/public/sw.js
//   cd frontend && pnpm build            # public/sw.js overwrites the built one
//   pnpm exec wrangler pages deploy frontend/dist --project-name <slug>
//
// Every navigation makes the browser re-fetch /sw.js. That path is
// Access-bypassed (scripts/setup-public-bypass.sh), so even a logged-out user
// receives this file rather than a login page. On the next app open, each
// client unregisters its worker, drops every cache, and reloads clean — no
// user action required.
//
// Undo by deleting frontend/public/sw.js and redeploying.

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) await caches.delete(key);
      await self.registration.unregister();
      for (const client of await self.clients.matchAll({ type: 'window' })) {
        client.navigate(client.url);
      }
    })()
  );
});

// Answer every request straight from the network while we are still installed.
self.addEventListener('fetch', (event) => event.respondWith(fetch(event.request)));

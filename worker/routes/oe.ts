import { Hono } from 'hono';
import type { AppContext } from '../types';

export const oeRoutes = new Hono<AppContext>();

// Server-side proxy for a *public* OpenEvidence conversation page.
//
// Why a proxy: the frontend can't `fetch()` openevidence.com directly — the
// response carries no `Access-Control-Allow-Origin`, so the browser blocks the
// cross-origin read. A Worker fetch has no CORS restriction (it's server-side),
// so we retrieve the HTML here and hand it back to the frontend, which parses
// the conversation turns with DOMParser (see frontend/src/lib/oe-import.ts).
//
// Only public `/ask/<id>` conversations resolve anonymously — OE returns them
// with HTTP 200 and full SSR content once the author has "made public". Private
// conversations redirect to login, which the parser surfaces as "no turns".
//
// Locked to the openevidence.com host so this can't be used as an open proxy.
const OE_HOSTS = new Set(['www.openevidence.com', 'openevidence.com']);
const MAX_HTML = 3 * 1024 * 1024; // 3MB — a conversation page is ~450KB

oeRoutes.get('/fetch', async (c) => {
  const raw = c.req.query('url') || '';
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return c.json({ error: 'bad url' }, 400);
  }
  if (parsed.protocol !== 'https:' || !OE_HOSTS.has(parsed.hostname.toLowerCase())) {
    return c.json({ error: 'not an openevidence.com url' }, 400);
  }
  if (!parsed.pathname.startsWith('/ask/')) {
    return c.json({ error: 'not an /ask/ conversation url' }, 400);
  }

  let resp: Response;
  try {
    resp = await fetch(`https://www.openevidence.com${parsed.pathname}`, {
      headers: {
        // A browser-like UA — some SSR hosts vary output for unknown agents.
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
        Accept: 'text/html',
      },
      redirect: 'follow',
    });
  } catch {
    return c.json({ error: 'fetch failed' }, 502);
  }
  // A redirect to login means the conversation isn't public.
  if (!resp.ok) return c.json({ error: `upstream ${resp.status}` }, 502);
  const finalUrl = resp.url || parsed.toString();
  if (!/\/ask\//.test(new URL(finalUrl).pathname)) {
    return c.json({ error: 'conversation is not public' }, 403);
  }

  const html = await resp.text();
  if (html.length > MAX_HTML) return c.json({ error: 'page too large' }, 413);

  return c.json({ html, url: finalUrl });
});

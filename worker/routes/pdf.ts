import { Hono } from 'hono';
import type { AppContext } from '../types';

export const pdfRoutes = new Hono<AppContext>();

// Catch-all under /pdf — Access has already validated the user upstream.
// Mirrors images.ts but adds HTTP Range support: pdfium (EmbedPDF) requests
// byte ranges for lazy per-page loading, so we honour `Range` with a 206.
pdfRoutes.get('/:key{.+}', async (c) => {
  const key = c.req.param('key');

  // Path traversal guard
  if (key.includes('..') || key.startsWith('/')) {
    return c.json({ error: 'invalid key' }, 400);
  }

  const rangeHeader = c.req.header('Range');

  // Parse `Range: bytes=start-end`. We support a single range; if the header
  // is malformed we fall through to serving the full object.
  if (rangeHeader) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
    if (match && (match[1] !== '' || match[2] !== '')) {
      // First, learn the full object size (HEAD-style get).
      const head = await c.env.R2.head(key);
      if (!head) return c.json({ error: 'not found' }, 404);

      const total = head.size;
      let start: number;
      let end: number;

      if (match[1] === '') {
        // suffix range: bytes=-N → last N bytes
        const suffix = parseInt(match[2], 10);
        start = Math.max(total - suffix, 0);
        end = total - 1;
      } else {
        start = parseInt(match[1], 10);
        end = match[2] === '' ? total - 1 : parseInt(match[2], 10);
      }
      if (end > total - 1) end = total - 1;

      // Unsatisfiable range
      if (start > end || start >= total) {
        return new Response(null, {
          status: 416,
          headers: {
            'Content-Range': `bytes */${total}`,
            'Accept-Ranges': 'bytes',
          },
        });
      }

      const length = end - start + 1;
      const obj = await c.env.R2.get(key, { range: { offset: start, length } });
      if (!obj) return c.json({ error: 'not found' }, 404);

      return new Response(obj.body, {
        status: 206,
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Length': String(length),
          'Content-Range': `bytes ${start}-${end}/${total}`,
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'private, max-age=86400',
          ETag: obj.httpEtag,
        },
      });
    }
  }

  // No (valid) Range header → full object, 200.
  const obj = await c.env.R2.get(key);
  if (!obj) return c.json({ error: 'not found' }, 404);

  return new Response(obj.body, {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Length': String(obj.size),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, max-age=86400',
      ETag: obj.httpEtag,
    },
  });
});

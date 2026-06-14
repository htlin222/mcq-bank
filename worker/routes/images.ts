import { Hono } from 'hono';
import type { AppContext } from '../types';

export const imagesRoutes = new Hono<AppContext>();

// Catch-all under /img — Access has already validated the user upstream
imagesRoutes.get('/:key{.+}', async (c) => {
  const key = c.req.param('key');

  // Path traversal guard
  if (key.includes('..') || key.startsWith('/')) {
    return c.json({ error: 'invalid key' }, 400);
  }

  const obj = await c.env.R2.get(key);
  if (!obj) return c.json({ error: 'not found' }, 404);

  return new Response(obj.body, {
    headers: {
      'Content-Type': obj.httpMetadata?.contentType || 'application/octet-stream',
      'Content-Length': String(obj.size),
      'Cache-Control': 'private, max-age=86400',
      // Stored content type is client-declared at upload; forbid sniffing
      // past it so a non-image disguised as one is never executed.
      'X-Content-Type-Options': 'nosniff',
      ETag: obj.httpEtag,
    },
  });
});

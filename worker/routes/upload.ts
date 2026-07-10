import { Hono } from 'hono';
import type { AppContext } from '../types';

export const uploadRoutes = new Hono<AppContext>();

const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const MAX_SIZE = 10 * 1024 * 1024; // 10MB

uploadRoutes.post('/', async (c) => {
  const email = c.var.email;
  const fd = await c.req.formData();
  // workers-types narrows FormData.get to `string | null`, but at runtime
  // multipart uploads come through as File (a Blob subclass). Cast.
  const file = fd.get('file') as unknown as (Blob & { type: string; size: number }) | string | null;

  if (!file || typeof file === 'string') return c.json({ error: 'no file' }, 400);
  if (file.size > MAX_SIZE) return c.json({ error: 'file >10MB' }, 413);
  if (!ALLOWED_TYPES.has(file.type)) {
    return c.json({ error: `unsupported type: ${file.type}` }, 415);
  }

  const ext = file.type.split('/')[1];
  const key = `img/${crypto.randomUUID()}.${ext}`;

  await c.env.R2.put(key, file.stream(), {
    httpMetadata: { contentType: file.type },
    customMetadata: { uploadedBy: email, uploadedAt: String(Date.now()) },
  });

  return c.json({ url: `/img/${key}`, key });
});

// Sideload an external image into R2. Used when pasting from sites that
// hotlink images (e.g. OpenEvidence → storage.googleapis.com): those URLs
// block foreign referrers and expire, so we fetch server-side (no CORS, no
// referrer check) and re-serve from our own /img/ proxy — same Zero Trust
// boundary as uploads.
const EXT_BY_TYPE: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

uploadRoutes.post('/url', async (c) => {
  const email = c.var.email;
  const { url } = await c.req.json<{ url?: string }>();

  if (!url || typeof url !== 'string') return c.json({ error: 'no url' }, 400);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return c.json({ error: 'bad url' }, 400);
  }
  // Only public http(s); reject internal hostnames as a basic SSRF guard.
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return c.json({ error: 'unsupported protocol' }, 400);
  }
  const host = parsed.hostname.toLowerCase();
  if (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host.endsWith('.internal') ||
    /^(10|127)\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  ) {
    return c.json({ error: 'blocked host' }, 400);
  }

  let resp: Response;
  try {
    resp = await fetch(parsed.toString(), {
      headers: { 'User-Agent': 'hema-2026-image-sideload/1.0' },
      redirect: 'follow',
    });
  } catch {
    return c.json({ error: 'fetch failed' }, 502);
  }
  if (!resp.ok) return c.json({ error: `upstream ${resp.status}` }, 502);

  const type = (resp.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!ALLOWED_TYPES.has(type)) {
    return c.json({ error: `unsupported type: ${type || 'unknown'}` }, 415);
  }
  const buf = await resp.arrayBuffer();
  if (buf.byteLength > MAX_SIZE) return c.json({ error: 'file >10MB' }, 413);

  const ext = EXT_BY_TYPE[type];
  const key = `img/${crypto.randomUUID()}.${ext}`;
  await c.env.R2.put(key, buf, {
    httpMetadata: { contentType: type },
    customMetadata: {
      uploadedBy: email,
      uploadedAt: String(Date.now()),
      sourceUrl: url.slice(0, 500),
    },
  });

  return c.json({ url: `/img/${key}`, key });
});

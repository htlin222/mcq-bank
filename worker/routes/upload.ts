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

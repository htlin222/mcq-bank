import { Hono } from 'hono';
import type { AppContext } from '../types';
import { sideloadImageToR2 } from '../lib/sideload';
import { validateImageFile, type UploadedFile } from '../lib/upload-validate';

export const uploadRoutes = new Hono<AppContext>();

uploadRoutes.post('/', async (c) => {
  const email = c.var.email;
  const fd = await c.req.formData();
  // workers-types narrows FormData.get to `string | null`, but at runtime
  // multipart uploads come through as File (a Blob subclass). Cast.
  const rawFile = fd.get('file') as unknown as UploadedFile | string | null;

  const check = validateImageFile(rawFile);
  if (!check.ok) return c.json({ error: check.error }, check.status);
  const file = rawFile as UploadedFile;

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
// boundary as uploads. Logic lives in lib/sideload.ts, shared with the
// /api/mcq note write path (skill-imported docs).
uploadRoutes.post('/url', async (c) => {
  const email = c.var.email;
  const { url } = await c.req.json<{ url?: string }>();

  if (!url || typeof url !== 'string') return c.json({ error: 'no url' }, 400);

  const result = await sideloadImageToR2(c.env, url, email);
  if (!result.ok) return c.json({ error: result.error }, result.status);
  return c.json({ url: result.url, key: result.key });
});

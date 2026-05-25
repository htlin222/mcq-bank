import { Hono } from 'hono';
import type { Context } from 'hono';
import { zipSync, strToU8 } from 'fflate';
import type { AppContext, User } from '../types';
import { deriveMcqKey } from '../lib/apikey';
import { MCQ_BUNDLE } from '../generated/mcq-bundle';

export const meRoutes = new Hono<AppContext>();

meRoutes.get('/', async (c) => {
  const email = c.var.email;
  const user = await c.env.DB
    .prepare('SELECT * FROM users WHERE email = ?')
    .bind(email)
    .first<User>();
  return c.json(user);
});

meRoutes.patch('/', async (c) => {
  const email = c.var.email;
  const body = await c.req.json<{ display_name?: string; bio?: string }>();
  const now = Date.now();

  if (body.display_name !== undefined) {
    const name = body.display_name.trim();
    if (name.length < 1 || name.length > 50) {
      return c.json({ error: 'name must be 1-50 chars' }, 400);
    }
  }

  await c.env.DB
    .prepare(
      `UPDATE users
       SET display_name = COALESCE(?, display_name),
           bio = COALESCE(?, bio),
           updated_at = ?
       WHERE email = ?`
    )
    .bind(body.display_name ?? null, body.bio ?? null, now, email)
    .run();

  const user = await c.env.DB
    .prepare('SELECT * FROM users WHERE email = ?')
    .bind(email)
    .first<User>();

  return c.json(user);
});

// ===== /mcq skill key (per-user, HMAC-derived) =============================
// These run behind Access, so c.var.email is the verified identity — no
// self-asserted X-User-Email here, unlike the public /api/mcq endpoint.

async function currentKey(c: Context<AppContext>) {
  const secret = c.env.MCQ_KEY_SECRET;
  if (!secret) return null;
  const email = c.var.email;
  const row = await c.env.DB.prepare(
    'SELECT mcq_key_version FROM users WHERE email = ?',
  )
    .bind(email)
    .first<{ mcq_key_version: number }>();
  const version = row?.mcq_key_version ?? 1;
  const key = await deriveMcqKey(secret, email, version);
  return { email, version, key };
}

// GET /api/me/mcq-key — current key + version, for display/copy in /profile.
meRoutes.get('/mcq-key', async (c) => {
  const k = await currentKey(c);
  if (!k) return c.json({ error: 'mcq api not configured' }, 503);
  return c.json(k);
});

// POST /api/me/mcq-key/rotate — bump the version salt. Any previously
// downloaded .skill (carrying the old key) starts returning 401.
meRoutes.post('/mcq-key/rotate', async (c) => {
  const secret = c.env.MCQ_KEY_SECRET;
  if (!secret) return c.json({ error: 'mcq api not configured' }, 503);
  const email = c.var.email;
  const row = await c.env.DB.prepare(
    `UPDATE users SET mcq_key_version = mcq_key_version + 1, updated_at = ?
     WHERE email = ? RETURNING mcq_key_version`,
  )
    .bind(Date.now(), email)
    .first<{ mcq_key_version: number }>();
  const version = row?.mcq_key_version ?? 1;
  const key = await deriveMcqKey(secret, email, version);
  return c.json({ email, version, key });
});

// GET /api/me/mcq-skill — download the personalised .skill bundle: the
// canonical mcq skill files (snapshotted into worker/generated/mcq-bundle.ts)
// plus a .env baked with this user's API base, derived key, and email. The
// archive layout mirrors `zip -r x.skill .` from inside the skill folder
// (SKILL.md + scripts/ at the root), matching the publish-the-skill format.
meRoutes.get('/mcq-skill', async (c) => {
  const k = await currentKey(c);
  if (!k) return c.json({ error: 'mcq api not configured' }, 503);

  const base = new URL(c.req.url).origin;
  const env =
    `# Auto-generated for ${k.email} — re-download from /profile anytime.\n` +
    `# Personal key (v${k.version}); rotating it on /profile invalidates this file.\n` +
    `MCQ_API_BASE=${base}\n` +
    `MCQ_API_KEY=${k.key}\n` +
    `MCQ_USER_EMAIL=${k.email}\n`;

  const files: Record<string, Uint8Array> = { '.env': strToU8(env) };
  for (const [name, content] of Object.entries(MCQ_BUNDLE)) {
    files[name] = strToU8(content);
  }

  const zip = zipSync(files, { level: 6 });
  return new Response(zip, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': 'attachment; filename="mcq.skill"',
      'Cache-Control': 'no-store',
    },
  });
});

// Allowed avatar MIME types. The client-supplied Content-Type can be
// anything, so we map only these to a known-good extension and reject the
// rest. Prevents weird strings ending up in R2 keys (e.g. `image/../foo`).
const AVATAR_MIME_TO_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

meRoutes.post('/avatar', async (c) => {
  const email = c.var.email;
  const fd = await c.req.formData();
  // workers-types narrows FormData.get to `string | null`, but at runtime
  // multipart uploads come through as File (a Blob subclass). Cast.
  const file = fd.get('file') as unknown as (Blob & { type: string; size: number }) | string | null;

  if (!file || typeof file === 'string') return c.json({ error: 'no file' }, 400);
  if (file.size > 2_000_000) return c.json({ error: 'avatar must be <2MB' }, 413);
  const ext = AVATAR_MIME_TO_EXT[file.type.toLowerCase()];
  if (!ext) {
    return c.json(
      { error: 'unsupported image type; png/jpg/webp/gif only' },
      415,
    );
  }

  const safeEmail = email.replace(/[^a-z0-9]/gi, '_');
  const key = `avatars/${safeEmail}.${ext}`;

  await c.env.R2.put(key, file.stream(), {
    httpMetadata: { contentType: file.type },
    customMetadata: { uploadedBy: email },
  });

  await c.env.DB
    .prepare('UPDATE users SET avatar_key = ?, updated_at = ? WHERE email = ?')
    .bind(key, Date.now(), email)
    .run();

  return c.json({ ok: true, avatar_key: key });
});

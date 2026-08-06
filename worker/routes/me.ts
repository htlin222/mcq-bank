import { Hono } from 'hono';
import type { Context } from 'hono';
import { zipSync, strToU8 } from 'fflate';
import type { AppContext, User } from '../types';
import { deriveMcqKey } from '../lib/apikey';
import { deriveBankKey } from '../lib/bank-key';
import { isAdminEmail } from '../lib/admin';
import { readIdemKey, idemLookup, idemRecordOp } from '../lib/idempotency';
import { MCQ_BUNDLE } from '../generated/mcq-bundle';
import { BANK_BUNDLE } from '../generated/bank-bundle';

export const meRoutes = new Hono<AppContext>();

meRoutes.get('/', async (c) => {
  const email = c.var.email;
  const user = await c.env.DB
    .prepare('SELECT * FROM users WHERE email = ?')
    .bind(email)
    .first<User>();
  // is_admin 是衍生值(ADMIN_EMAILS),不是 users 的欄位。前端只拿它決定要不要
  // 顯示入口 —— 每個 admin-only 端點自己都還會再驗一次。
  return c.json({ ...user, is_admin: isAdminEmail(email, c.env) });
});

meRoutes.patch('/', async (c) => {
  const email = c.var.email;
  const body = await c.req.json<{
    display_name?: string;
    bio?: string;
    chat_notify?: string;
  }>();
  const now = Date.now();

  if (body.display_name !== undefined) {
    const name = body.display_name.trim();
    if (name.length < 1 || name.length > 50) {
      return c.json({ error: 'name must be 1-50 chars' }, 400);
    }
  }

  if (
    body.chat_notify !== undefined &&
    !['all', 'mention', 'off'].includes(body.chat_notify)
  ) {
    return c.json({ error: 'chat_notify must be all|mention|off' }, 400);
  }

  await c.env.DB
    .prepare(
      `UPDATE users
       SET display_name = COALESCE(?, display_name),
           bio = COALESCE(?, bio),
           chat_notify = COALESCE(?, chat_notify),
           updated_at = ?
       WHERE email = ?`
    )
    .bind(
      body.display_name ?? null,
      body.bio ?? null,
      body.chat_notify ?? null,
      now,
      email,
    )
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

  // 冪等:重送同一 key 直接 replay,version 不重複 +1(否則舊 .skill 會被
  // 多推一版而莫名失效)。
  const idemKey = readIdemKey(c);
  if (idemKey) {
    const hit = await idemLookup(c.env.DB, email, idemKey);
    if (hit) return c.json(hit.body as any, hit.status as any);
  }

  // 先讀現值、算出新版號,再以確定值寫回 —— 讓 payload 在 batch 前就已知,
  // 去重列與 UPDATE 得以同進同退。
  const cur = await c.env.DB.prepare(
    'SELECT mcq_key_version FROM users WHERE email = ?',
  )
    .bind(email)
    .first<{ mcq_key_version: number }>();
  const version = (cur?.mcq_key_version ?? 1) + 1;
  const now = Date.now();
  const key = await deriveMcqKey(secret, email, version);
  const payload = { email, version, key };

  const ops = [
    c.env.DB
      .prepare('UPDATE users SET mcq_key_version = ?, updated_at = ? WHERE email = ?')
      .bind(version, now, email),
  ];
  if (idemKey) {
    ops.push(
      idemRecordOp(c.env.DB, {
        email,
        key: idemKey,
        endpoint: 'POST /me/mcq-key/rotate',
        status: 200,
        body: payload,
        now,
      }),
    );
  }
  await c.env.DB.batch(ops);

  return c.json(payload);
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

// ===== bank-ingest skill key (admin-only) ==================================
// 新年份題庫匯入的特權金鑰。與上面的 mcq 金鑰刻意分家:那把是 ~20 人拿著的
// 讀取金鑰,這把寫得到暫存區、只發給 ADMIN_EMAILS。
// 設計文件:docs/plans/2026-08-06-new-year-ingest-design.md

async function currentBankKey(c: Context<AppContext>) {
  const secret = c.env.BANK_KEY_SECRET;
  if (!secret) return null;
  const email = c.var.email;
  const row = await c.env.DB.prepare(
    'SELECT bank_key_version FROM users WHERE email = ?',
  )
    .bind(email)
    .first<{ bank_key_version: number }>();
  const version = row?.bank_key_version ?? 1;
  const key = await deriveBankKey(secret, email, version);
  return { email, version, key };
}

// POST /api/me/bank-key/rotate — 撤銷已下載的 bank-ingest.skill。
// 與 mcq 金鑰各自獨立:撤銷寫入權不會連帶弄壞那個人的 /mcq 讀題。
meRoutes.post('/bank-key/rotate', async (c) => {
  const email = c.var.email;
  if (!isAdminEmail(email, c.env)) return c.json({ error: 'forbidden' }, 403);
  if (!c.env.BANK_KEY_SECRET) return c.json({ error: 'bank ingest not configured' }, 503);

  const cur = await c.env.DB.prepare(
    'SELECT bank_key_version FROM users WHERE email = ?',
  )
    .bind(email)
    .first<{ bank_key_version: number }>();
  const version = (cur?.bank_key_version ?? 1) + 1;
  const now = Date.now();

  await c.env.DB.prepare(
    'UPDATE users SET bank_key_version = ?, updated_at = ? WHERE email = ?',
  )
    .bind(version, now, email)
    .run();

  return c.json({ ok: true, version });
});

// GET /api/me/bank-skill — 下載個人化的 bank-ingest.skill。
//
// 403 而不是隱藏按鈕:前端的 admin 判斷只是 UI,真正的門在這裡。
meRoutes.get('/bank-skill', async (c) => {
  if (!isAdminEmail(c.var.email, c.env)) return c.json({ error: 'forbidden' }, 403);
  const k = await currentBankKey(c);
  if (!k) return c.json({ error: 'bank ingest not configured' }, 503);

  const base = new URL(c.req.url).origin;
  const env =
    `# Auto-generated for ${k.email} — 隨時可從「加入新年份」精靈重新下載。\n` +
    `# 特權金鑰 (v${k.version});在精靈裡按「重新產生」會讓這個檔案失效。\n` +
    `# 這把金鑰只寫得到匯入暫存區,不能發布 —— 發布必須回瀏覽器操作。\n` +
    `BANK_API_BASE=${base}\n` +
    `BANK_API_KEY=${k.key}\n` +
    `BANK_USER_EMAIL=${k.email}\n`;

  const files: Record<string, Uint8Array> = { '.env': strToU8(env) };
  for (const [name, content] of Object.entries(BANK_BUNDLE)) {
    files[name] = strToU8(content);
  }

  const zip = zipSync(files, { level: 6 });
  return new Response(zip, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': 'attachment; filename="bank-ingest.skill"',
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

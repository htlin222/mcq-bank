import type { MiddlewareHandler } from 'hono';
import type { AppContext, Env } from '../types';
import { isAdminEmail } from './admin';

/**
 * Per-admin API-key auth for the `/api/bank-ingest` endpoints used by the
 * `bank-ingest` skill (新年份題庫匯入).
 *
 * Same shape as worker/lib/apikey.ts, deliberately kept as a separate key
 * with a separate secret and a separate version salt:
 *
 *   mcqk_… → read questions.        ~20 people carry it.
 *   bnkk_… → write the staging area. Admins only.
 *
 * Folding write access into the mcq key would mean one leaked read key —
 * of which there are twenty, living on twenty laptops, usable from outside
 * Access — could also write to the bank. Two keys, two blast radii.
 *
 *   key = "bnkk_" + b64url(HMAC-SHA256(BANK_KEY_SECRET, `${email}:bank:${version}`))
 *
 * The `:bank:` infix means that even if BANK_KEY_SECRET and MCQ_KEY_SECRET
 * were ever set to the same value by mistake, the two keys still differ.
 *
 * What this key CANNOT do: publish. Everything here writes only to
 * import_jobs / import_staging, which no student-facing query reads.
 * Promoting a staged year into `questions` requires an Access session plus
 * ADMIN_EMAILS membership — see worker/routes/admin-import.ts.
 */

const KEY_PREFIX = 'bnkk_';

// Workers runtime adds timingSafeEqual to SubtleCrypto; the standard lib type
// doesn't declare it, so widen the type here.
const subtle = crypto.subtle as SubtleCrypto & {
  timingSafeEqual(a: ArrayBuffer, b: ArrayBuffer): boolean;
};

function b64url(bytes: ArrayBuffer): string {
  let bin = '';
  const arr = new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Derive the stable per-admin key. Pure function of (secret, email, version):
 * the same inputs always reproduce the same key, so the download endpoint can
 * re-bake a `.env` at any time and this middleware can re-validate it.
 */
export async function deriveBankKey(
  secret: string,
  email: string,
  version: number,
): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign(
    'HMAC',
    cryptoKey,
    enc.encode(`${email.trim().toLowerCase()}:bank:${version}`),
  );
  return KEY_PREFIX + b64url(sig);
}

/** Constant-time string compare via fixed-length digests. */
async function safeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [ah, bh] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  return subtle.timingSafeEqual(ah, bh);
}

export const bankKeyMiddleware: MiddlewareHandler<AppContext> = async (c, next) => {
  const secret = c.env.BANK_KEY_SECRET;
  if (!secret) {
    // Fail closed if the secret was never set.
    return c.json({ error: 'bank ingest not configured' }, 503);
  }

  const auth = c.req.header('Authorization') ?? '';
  const presented = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const email = (c.req.header('X-User-Email') ?? '').trim().toLowerCase();
  if (!presented) return c.json({ error: 'missing bearer key' }, 400);
  if (!email) return c.json({ error: 'missing X-User-Email' }, 400);

  const row = await c.env.DB.prepare(
    'SELECT bank_key_version FROM users WHERE email = ?',
  )
    .bind(email)
    .first<{ bank_key_version: number }>();

  // Unknown email, non-admin, and bad key must all be indistinguishable: this
  // path is Access-bypassed (public), so a distinct 403 would let anyone
  // enumerate who the admins are. Versions start at 1, so deriving with 0 for
  // a non-existent / non-admin user can never match a minted key, and the
  // HMAC + compare still run to keep timing uniform.
  const eligible = !!row && isAdminEmail(email, c.env);
  const expected = await deriveBankKey(
    secret,
    email,
    eligible ? row.bank_key_version : 0,
  );
  if (!eligible || !(await safeEqual(presented, expected))) {
    return c.json({ error: 'unauthorized' }, 401);
  }

  console.log(`[bank-ingest] ${email} (v${row.bank_key_version}) → ${c.req.path}`);
  c.set('email', email);
  await next();
};

export type { Env };

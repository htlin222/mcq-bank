import type { MiddlewareHandler } from 'hono';
import type { AppContext, Env } from '../types';

/**
 * Per-user API-key auth for the read-only /api/mcq endpoint used by the
 * `/mcq` skill.
 *
 * This path is *bypassed* in Cloudflare Access so external Claude Code /
 * claude.ai requests — which carry no Access session — can reach the Worker.
 * That makes this middleware the ONLY gate.
 *
 * Each member's key is HMAC-derived, never stored:
 *   key = "mcqk_" + b64url(HMAC-SHA256(MCQ_KEY_SECRET, `${email}:${version}`))
 *
 * - `MCQ_KEY_SECRET` is one global Worker secret. Leaking the D1 DB leaks no
 *   keys, because D1 holds only the non-secret `mcq_key_version` salt.
 * - The caller asserts its email via `X-User-Email`. That email selects the
 *   user row (→ version + allowlist check) and is bound into the HMAC, so a
 *   key only works for the email it was minted for.
 * - Rotating one user = bump `users.mcq_key_version`; their old `.skill` 401s,
 *   nobody else is affected.
 */

const KEY_PREFIX = 'mcqk_';

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
 * Derive the stable per-user key. Pure function of (secret, email, version):
 * the same inputs always reproduce the same key, so the download endpoint can
 * re-bake a member's `.env` at any time and this middleware can re-validate it.
 */
export async function deriveMcqKey(
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
    enc.encode(`${email.trim().toLowerCase()}:${version}`),
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

export const apiKeyMiddleware: MiddlewareHandler<AppContext> = async (c, next) => {
  const secret = c.env.MCQ_KEY_SECRET;
  if (!secret) {
    // Fail closed if the secret was never set.
    return c.json({ error: 'mcq api not configured' }, 503);
  }

  const auth = c.req.header('Authorization') ?? '';
  const presented = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const email = (c.req.header('X-User-Email') ?? '').trim().toLowerCase();
  if (!presented) return c.json({ error: 'missing bearer key' }, 400);
  if (!email) return c.json({ error: 'missing X-User-Email' }, 400);

  // The email both selects the user row (allowlist + revocation) and provides
  // the per-user version that the key is bound to.
  const row = await c.env.DB.prepare(
    'SELECT mcq_key_version FROM users WHERE email = ?',
  )
    .bind(email)
    .first<{ mcq_key_version: number }>();

  // Unknown email and bad key must be indistinguishable: this path is
  // Access-bypassed (public), so a distinct 403 would let anyone enumerate
  // roster membership. Versions start at 1, so deriving with 0 for unknown
  // emails can never match a minted key, and the HMAC + compare still run
  // to keep timing uniform.
  const expected = await deriveMcqKey(secret, email, row?.mcq_key_version ?? 0);
  if (!row || !(await safeEqual(presented, expected))) {
    return c.json({ error: 'unauthorized' }, 401);
  }

  console.log(`[mcq-api] ${email} (v${row.mcq_key_version}) → ${c.req.path}`);
  c.set('email', email);
  await next();
};

// Re-export Env so callers can `import type { Env }` alongside the helper if
// they want; keeps the auth surface in one module.
export type { Env };

import type { MiddlewareHandler } from 'hono';
import type { AppContext } from '../types';

/**
 * API-key auth for the read-only /api/mcq endpoint used by the `/mcq` skill.
 *
 * This path is *bypassed* in Cloudflare Access so external Claude Code /
 * claude.ai requests — which carry no Access session — can reach the Worker.
 * That makes this middleware the ONLY gate, so:
 *   1. The shared key is compared in constant time (SHA-256 + timingSafeEqual)
 *      to avoid leaking it through response timing.
 *   2. The caller must also assert a known member email (X-User-Email) present
 *      in `users`. That email is self-asserted (NOT Access-verified), so it's a
 *      defence-in-depth / audit / soft-revocation layer, not a cryptographic
 *      second factor.
 */

// Workers runtime adds timingSafeEqual to SubtleCrypto; the standard lib type
// doesn't declare it, so widen the type here.
const subtle = crypto.subtle as SubtleCrypto & {
  timingSafeEqual(a: ArrayBuffer, b: ArrayBuffer): boolean;
};

async function safeEqual(a: string, b: string): Promise<boolean> {
  // Hash both to a fixed 32-byte digest first so a length mismatch can't
  // short-circuit the comparison and leak timing.
  const enc = new TextEncoder();
  const [ah, bh] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  return subtle.timingSafeEqual(ah, bh);
}

export const apiKeyMiddleware: MiddlewareHandler<AppContext> = async (c, next) => {
  const configured = c.env.MCQ_API_KEY;
  if (!configured) {
    // Fail closed if the secret was never set.
    return c.json({ error: 'mcq api not configured' }, 503);
  }

  const auth = c.req.header('Authorization') ?? '';
  const presented = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!presented || !(await safeEqual(presented, configured))) {
    return c.json({ error: 'unauthorized' }, 401);
  }

  const email = (c.req.header('X-User-Email') ?? '').trim().toLowerCase();
  if (!email) {
    return c.json({ error: 'missing X-User-Email' }, 400);
  }
  const row = await c.env.DB.prepare('SELECT email FROM users WHERE email = ?')
    .bind(email)
    .first<{ email: string }>();
  if (!row) {
    return c.json({ error: 'email not in allowlist' }, 403);
  }

  console.log(`[mcq-api] ${email} → ${c.req.path}`);
  c.set('email', email);
  await next();
};

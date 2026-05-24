import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { Context, Next } from 'hono';
import type { AppContext } from '../types';

/**
 * Cloudflare Access JWT verification.
 *
 * Every request to a Worker behind Access has the header
 *   Cf-Access-Jwt-Assertion: <jwt>
 * We verify against CF's public JWKS, then trust the email claim.
 *
 * If a route is in CF Access's *Bypass* policy (e.g. /api/me, so the
 * public landing page can probe auth state without triggering a redirect),
 * the header won't be forwarded — but the same JWT is also present as the
 * `CF_Authorization` cookie set on the apex domain after login, so we fall
 * back to that.
 *
 * For local dev (wrangler dev), Access doesn't run, so we fall back to
 * a header `X-Dev-Email` for testing.
 */

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function getJWKS(teamDomain: string) {
  const url = `https://${teamDomain}/cdn-cgi/access/certs`;
  let jwks = jwksCache.get(url);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(url));
    jwksCache.set(url, jwks);
  }
  return jwks;
}

function jwtFromRequest(c: Context<AppContext>): string | null {
  const header = c.req.header('Cf-Access-Jwt-Assertion');
  if (header) return header;
  const cookie = c.req.header('Cookie');
  if (!cookie) return null;
  for (const part of cookie.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === 'CF_Authorization') {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return null;
}

export async function authMiddleware(c: Context<AppContext>, next: Next) {
  const token = jwtFromRequest(c);

  // Local dev fallback — Access isn't in front of `wrangler dev`
  if (!token) {
    const devEmail = c.req.header('X-Dev-Email');
    if (devEmail && c.env.CF_ACCESS_TEAM_DOMAIN === 'localhost') {
      c.set('email', devEmail);
      await upsertUser(c.env.DB, devEmail);
      return next();
    }
    return c.json({ error: 'unauthenticated' }, 401);
  }

  try {
    const jwks = getJWKS(c.env.CF_ACCESS_TEAM_DOMAIN);
    const { payload } = await jwtVerify(token, jwks, {
      issuer: `https://${c.env.CF_ACCESS_TEAM_DOMAIN}`,
      audience: c.env.CF_ACCESS_AUD,
    });

    const email = (payload.email as string) || '';
    if (!email) return c.json({ error: 'no email claim' }, 401);

    c.set('email', email);
    await upsertUser(c.env.DB, email);
    return next();
  } catch (err) {
    return c.json({ error: 'invalid token', detail: String(err) }, 401);
  }
}

// "Online" presence: keep `users.last_seen_at` fresh, but throttle to one
// write per user per 5 min so D1 free-tier write budget stays comfortable.
// The widget considers anyone seen in the last 5 min online.
const PRESENCE_THROTTLE_MS = 5 * 60 * 1000;

async function upsertUser(db: D1Database, email: string) {
  const now = Date.now();
  const defaultName = email.split('@')[0];
  await db
    .prepare(
      `INSERT INTO users (email, display_name, created_at, updated_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(email) DO NOTHING`
    )
    .bind(email, defaultName, now, now, now)
    .run();
  const cutoff = now - PRESENCE_THROTTLE_MS;
  await db
    .prepare(
      `UPDATE users SET last_seen_at = ?
       WHERE email = ? AND (last_seen_at IS NULL OR last_seen_at < ?)`
    )
    .bind(now, email, cutoff)
    .run();
}

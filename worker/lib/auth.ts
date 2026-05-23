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
 * For local dev (wrangler dev), Access doesn't run, so we fall back to
 * a header `X-Dev-Email` for testing. In production, the absence of
 * Cf-Access-Jwt-Assertion means the request bypassed Access — reject it.
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

export async function authMiddleware(c: Context<AppContext>, next: Next) {
  const token = c.req.header('Cf-Access-Jwt-Assertion');

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

async function upsertUser(db: D1Database, email: string) {
  const now = Date.now();
  const defaultName = email.split('@')[0];
  await db
    .prepare(
      `INSERT INTO users (email, display_name, created_at, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(email) DO NOTHING`
    )
    .bind(email, defaultName, now, now)
    .run();
}

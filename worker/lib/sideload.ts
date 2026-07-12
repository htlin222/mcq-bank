import type { Env } from '../types';

// Fetch an external image server-side and re-serve it from R2 behind the
// /img/ proxy. Shared by POST /api/upload/url (web editor paste) and the
// /api/mcq note write path (skill-imported docs) — hotlinked sources like
// OpenEvidence figures block foreign referrers and expire, so persisting to
// R2 keeps notes readable and inside the Zero Trust boundary.

export const ALLOWED_IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
]);
export const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB

const EXT_BY_TYPE: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

export type SideloadResult =
  | { ok: true; url: string; key: string }
  | { ok: false; error: string; status: 400 | 413 | 415 | 502 };

// Only public http(s); reject internal hostnames as a basic SSRF guard.
export function blockedImageUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'bad url';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return 'unsupported protocol';
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
    return 'blocked host';
  }
  return null;
}

export async function sideloadImageToR2(
  env: Env,
  url: string,
  email: string,
): Promise<SideloadResult> {
  const blocked = blockedImageUrl(url);
  if (blocked) return { ok: false, error: blocked, status: 400 };

  let resp: Response;
  try {
    resp = await fetch(url, {
      headers: { 'User-Agent': 'hema-2026-image-sideload/1.0' },
      redirect: 'follow',
    });
  } catch {
    return { ok: false, error: 'fetch failed', status: 502 };
  }
  if (!resp.ok) return { ok: false, error: `upstream ${resp.status}`, status: 502 };

  const type = (resp.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!ALLOWED_IMAGE_TYPES.has(type)) {
    return { ok: false, error: `unsupported type: ${type || 'unknown'}`, status: 415 };
  }
  const buf = await resp.arrayBuffer();
  if (buf.byteLength > MAX_IMAGE_SIZE) {
    return { ok: false, error: 'file >10MB', status: 413 };
  }

  const key = `img/${crypto.randomUUID()}.${EXT_BY_TYPE[type]}`;
  await env.R2.put(key, buf, {
    httpMetadata: { contentType: type },
    customMetadata: {
      uploadedBy: email,
      uploadedAt: String(Date.now()),
      sourceUrl: url.slice(0, 500),
    },
  });

  return { ok: true, url: `/img/${key}`, key };
}

#!/usr/bin/env node
/**
 * Customize the Cloudflare Access login page (the OTP screen at
 * htlin.cloudflareaccess.com) via the Zero Trust API.
 *
 * Fills in `login_design` on the Access organization. Cloudflare only
 * exposes five knobs there — background_color, text_color, header_text,
 * footer_text, logo_path — so this script just sends a PUT with the
 * values below.
 *
 * Reads CF_API_TOKEN, CF_ACCOUNT_ID from .env. Idempotent: re-running
 * just overwrites the same fields.
 *
 *   node scripts/polish-access-login.ts            # apply
 *   node scripts/polish-access-login.ts --dry-run  # show diff only
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const ENV_PATH = resolve(ROOT, '.env');

const DESIGN = {
  background_color: '#F5EFE3',
  text_color: '#1F1B16',
  header_text: '請用已登記的 email 登入',
  footer_text: 'hema-2026 · 國考共筆讀書會',
  logo_path: '',
} as const;

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const env = await loadEnv();
  must(env, ['CF_API_TOKEN', 'CF_ACCOUNT_ID']);

  const base = `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/access/organizations`;
  const headers = {
    Authorization: `Bearer ${env.CF_API_TOKEN}`,
    'Content-Type': 'application/json',
  };

  console.log('▶ Fetching current login_design…');
  const before = await getJson(base, headers);
  const current = before.result?.login_design ?? {};
  printDesign('  current:', current);
  console.log('');
  printDesign('  target :', DESIGN);

  if (dryRun) {
    console.log('\n(--dry-run, nothing changed)');
    return;
  }

  console.log('\n▶ PUT /access/organizations with new login_design…');
  const res = await fetch(base, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      name: before.result.name,
      auth_domain: before.result.auth_domain,
      login_design: DESIGN,
    }),
  });
  const body = await res.json();
  if (!res.ok || !body.success) {
    console.error('❌ PUT failed:', JSON.stringify(body, null, 2));
    process.exit(1);
  }
  console.log('  ✅ login_design updated');

  console.log('\n▶ Re-fetch to confirm:');
  const after = await getJson(base, headers);
  printDesign('  now:', after.result?.login_design ?? {});

  console.log('\nDone. Visit your protected URL in an incognito window to see it:');
  console.log(`  https://${env.PAGES_DOMAIN ?? '<PAGES_DOMAIN>'}`);
}

function printDesign(label: string, d: Record<string, unknown>) {
  console.log(label);
  for (const k of ['background_color', 'text_color', 'header_text', 'footer_text', 'logo_path']) {
    const v = (d as Record<string, unknown>)[k];
    console.log(`    ${k.padEnd(18)} ${v ? JSON.stringify(v) : '(empty)'}`);
  }
}

async function getJson(url: string, headers: Record<string, string>) {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`${url} → ${res.status}: ${await res.text()}`);
  return res.json() as Promise<{ result: Record<string, any>; success: boolean }>;
}

async function loadEnv(): Promise<Record<string, string>> {
  const raw = await readFile(ENV_PATH, 'utf8');
  const out: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

function must(env: Record<string, string>, keys: string[]) {
  const missing = keys.filter((k) => !env[k]);
  if (missing.length) {
    console.error(`❌ Missing in .env: ${missing.join(', ')}`);
    process.exit(2);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

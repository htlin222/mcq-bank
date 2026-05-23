#!/usr/bin/env node
/**
 * Cloudflare Access setup + roster sync — idempotent, one-stop.
 *
 * What it does:
 *   1. Fetches the email roster from the Google Sheet (ROSTER_CSV_URL).
 *   2. Merges with ADMIN_EMAILS.
 *   3. Looks up the Access app at PAGES_DOMAIN; creates it if absent.
 *   4. Replaces its policy's include[] with the merged email allow-list.
 *   5. Pushes CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD as Worker secrets
 *      (only when they're not already set in production).
 *   6. Persists ACCESS_APP_ID back into .env for future runs.
 *
 * Reads .env at repo root. Required keys:
 *   CF_API_TOKEN, CF_ACCOUNT_ID, PAGES_DOMAIN, ADMIN_EMAILS, ROSTER_CSV_URL
 * Optional:
 *   ACCESS_APP_ID (auto-filled on first run)
 *
 * Run after changing the roster sheet, or whenever you want to push
 * Access state into prod:
 *   node scripts/sync-access.ts
 */

import { readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const ENV_PATH = resolve(ROOT, '.env');

type Env = Record<string, string>;

async function main() {
  const env = await loadEnv();
  must(env, ['CF_API_TOKEN', 'CF_ACCOUNT_ID', 'PAGES_DOMAIN', 'ADMIN_EMAILS', 'ROSTER_CSV_URL']);

  // 1. Roster
  console.log('▶ Fetching roster from sheet…');
  const roster = await fetchRoster(env.ROSTER_CSV_URL);
  const admins = env.ADMIN_EMAILS.split(',').map((e) => e.trim()).filter(Boolean);
  const merged = uniqLower([...admins, ...roster]);
  console.log(`  ${roster.length} sheet + ${admins.length} admin → ${merged.length} unique`);
  for (const e of merged) console.log(`    · ${e}`);

  // 2. Lookup or create Access app
  let appId = env.ACCESS_APP_ID;
  if (!appId) {
    console.log('\n▶ Looking up Access app at', env.PAGES_DOMAIN);
    const existing = await findApp(env, env.PAGES_DOMAIN);
    if (existing) {
      appId = existing.id;
      console.log(`  Found existing app: ${appId}`);
    } else {
      console.log('  Creating new Access app…');
      const created = await createApp(env);
      appId = created.id;
      console.log(`  Created: ${appId}`);
      console.log(`  AUD:     ${created.aud}`);
      await pushSecret('CF_ACCESS_AUD', created.aud);
    }
  } else {
    console.log(`\n▶ Using saved ACCESS_APP_ID: ${appId}`);
  }

  // 3. Fetch app to get aud (and confirm it still exists)
  const app = await getApp(env, appId);
  if (!app) {
    console.error(`❌ App ${appId} not found. Clear ACCESS_APP_ID from .env and re-run.`);
    process.exit(2);
  }

  // 4. Sync policy
  console.log('\n▶ Syncing Access policy include[] with roster…');
  const policies = await listPolicies(env, appId);
  let policyId = policies.find((p) => p.name === 'Allowed users')?.id;
  const include = merged.map((email) => ({ email: { email } }));

  if (policyId) {
    await updatePolicy(env, appId, policyId, include);
    console.log(`  Updated policy ${policyId}`);
  } else {
    policyId = await createPolicy(env, appId, include);
    console.log(`  Created policy ${policyId}`);
  }

  // 5. Push team-domain secret (idempotent — wrangler dedupes)
  const org = await getOrg(env);
  console.log('\n▶ Worker secrets');
  await pushSecret('CF_ACCESS_TEAM_DOMAIN', org.auth_domain);
  await pushSecret('CF_ACCESS_AUD', app.aud);

  // 6. Persist ACCESS_APP_ID
  if (env.ACCESS_APP_ID !== appId) {
    await persistEnv('ACCESS_APP_ID', appId);
    console.log(`\n✓ Saved ACCESS_APP_ID to .env`);
  }

  console.log('\n================================');
  console.log('✅ Access sync complete.');
  console.log(`   Team domain : ${org.auth_domain}`);
  console.log(`   App         : ${appId}`);
  console.log(`   AUD         : ${app.aud}`);
  console.log(`   Users       : ${merged.length}`);
  console.log(`   URL         : https://${env.PAGES_DOMAIN}`);
}

// ------------------------------------------------------------ env
async function loadEnv(): Promise<Env> {
  const txt = await readFile(ENV_PATH, 'utf-8');
  const env: Env = {};
  for (const line of txt.split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}

function must(env: Env, keys: string[]) {
  const missing = keys.filter((k) => !env[k]);
  if (missing.length) {
    console.error('❌ Missing required .env keys:', missing.join(', '));
    process.exit(1);
  }
}

async function persistEnv(key: string, value: string) {
  const txt = await readFile(ENV_PATH, 'utf-8');
  const re = new RegExp(`^${key}=.*$`, 'm');
  const next = re.test(txt) ? txt.replace(re, `${key}=${value}`) : txt + `\n${key}=${value}\n`;
  await writeFile(ENV_PATH, next, 'utf-8');
}

// ------------------------------------------------------------ roster
async function fetchRoster(url: string): Promise<string[]> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`roster fetch ${res.status}`);
  const csv = await res.text();
  const lines = csv.split('\n').slice(1); // drop header
  const emails: string[] = [];
  for (const line of lines) {
    const cols = parseCsvLine(line);
    const email = cols[3]?.trim();
    if (email && email.includes('@')) emails.push(email);
  }
  return emails;
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else {
      if (c === '"') q = true;
      else if (c === ',') { out.push(cur); cur = ''; }
      else cur += c;
    }
  }
  out.push(cur);
  return out;
}

function uniqLower(arr: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const e of arr) {
    const k = e.toLowerCase();
    if (!seen.has(k)) { seen.add(k); out.push(k); }
  }
  return out.sort();
}

// ------------------------------------------------------------ CF Access API
const API = 'https://api.cloudflare.com/client/v4';

async function cf(env: Env, method: string, path: string, body?: any) {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.CF_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json: any = await r.json();
  if (!r.ok || json.success === false) {
    throw new Error(`CF ${method} ${path}: ${r.status} ${JSON.stringify(json.errors || json)}`);
  }
  return json.result;
}

async function findApp(env: Env, domain: string) {
  const apps = await cf(env, 'GET', `/accounts/${env.CF_ACCOUNT_ID}/access/apps?per_page=100`);
  return (apps as any[]).find((a) => a.domain === domain);
}

async function getApp(env: Env, appId: string) {
  try {
    return await cf(env, 'GET', `/accounts/${env.CF_ACCOUNT_ID}/access/apps/${appId}`);
  } catch {
    return null;
  }
}

async function createApp(env: Env) {
  return cf(env, 'POST', `/accounts/${env.CF_ACCOUNT_ID}/access/apps`, {
    name: 'hema-2026 共筆',
    domain: env.PAGES_DOMAIN,
    type: 'self_hosted',
    session_duration: '720h',          // 30 days
    app_launcher_visible: true,
    allowed_idps: [],                  // default = one-time PIN (email OTP)
    auto_redirect_to_identity: false,
  });
}

async function listPolicies(env: Env, appId: string) {
  return cf(env, 'GET', `/accounts/${env.CF_ACCOUNT_ID}/access/apps/${appId}/policies`) as Promise<any[]>;
}

async function createPolicy(env: Env, appId: string, include: any[]) {
  const p = await cf(env, 'POST', `/accounts/${env.CF_ACCOUNT_ID}/access/apps/${appId}/policies`, {
    name: 'Allowed users',
    decision: 'allow',
    include,
  });
  return p.id;
}

async function updatePolicy(env: Env, appId: string, policyId: string, include: any[]) {
  await cf(env, 'PUT', `/accounts/${env.CF_ACCOUNT_ID}/access/apps/${appId}/policies/${policyId}`, {
    name: 'Allowed users',
    decision: 'allow',
    include,
  });
}

async function getOrg(env: Env) {
  return cf(env, 'GET', `/accounts/${env.CF_ACCOUNT_ID}/access/organizations`);
}

// ------------------------------------------------------------ wrangler
function pushSecret(name: string, value: string): Promise<void> {
  return new Promise((resolveP, rejectP) => {
    const p = spawn('wrangler', ['secret', 'put', name], {
      stdio: ['pipe', 'inherit', 'inherit'],
      cwd: ROOT,
    });
    p.stdin.write(value + '\n');
    p.stdin.end();
    p.on('exit', (c) => (c === 0 ? resolveP() : rejectP(new Error(`wrangler secret put ${name} → ${c}`))));
  });
}

main().catch((e) => { console.error(e); process.exit(1); });

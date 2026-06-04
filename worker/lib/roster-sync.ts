/**
 * Roster → Access policy + D1 users sync, runnable inside the Worker.
 *
 * This is the *recurring* subset of scripts/sync-access.ts — the part that
 * makes sense to run on a Cron Trigger every day:
 *
 *   1. Fetch the email roster from the Google Sheet (ROSTER_CSV_URL).
 *   2. Merge with ADMIN_EMAILS.
 *   3. Replace the Access app's "Allowed users" policy include[] with the
 *      merged allow-list (revoke-on-removal — matches the script).
 *   4. Upsert the merged emails into D1 `users` so they appear in @mention
 *      pickers before first login. ON CONFLICT preserves custom names.
 *
 * It intentionally does NOT create the Access app or push CF_ACCESS_*
 * secrets — those are one-time setup steps that stay in sync-access.ts
 * (and a Worker can't shell out to `wrangler secret put` anyway).
 *
 * Required env bindings: CF_API_TOKEN (secret), CF_ACCOUNT_ID,
 * ACCESS_APP_ID, ROSTER_CSV_URL. ADMIN_EMAILS is optional.
 */
import type { Env } from '../types';

const CF_API = 'https://api.cloudflare.com/client/v4';

export type RosterSyncResult = {
  roster: number;
  admins: number;
  merged: number;
  policyId: string;
  emails: string[];
};

// CSV parsing — mirrors scripts/sync-access.ts so the two stay in step.
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
    const k = e.trim().toLowerCase();
    if (k && !seen.has(k)) { seen.add(k); out.push(k); }
  }
  return out.sort();
}

async function fetchRoster(url: string): Promise<string[]> {
  // Bypass CF's edge cache so the cron sees the freshest publish-to-web state.
  const res = await fetch(url, { cf: { cacheTtl: 0 } });
  if (!res.ok) throw new Error(`roster fetch ${res.status}`);
  const csv = await res.text();
  const lines = csv.split('\n').slice(1); // drop header
  const emails: string[] = [];
  for (const line of lines) {
    const email = parseCsvLine(line)[3]?.trim(); // Email is column index 3
    if (email && email.includes('@')) emails.push(email);
  }
  return emails;
}

async function cf<T = any>(env: Env, method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${CF_API}${path}`, {
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
  return json.result as T;
}

async function seedUsers(env: Env, emails: string[]): Promise<void> {
  if (emails.length === 0) return;
  const now = Date.now();
  const stmt = env.DB.prepare(
    `INSERT INTO users (email, display_name, created_at, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(email) DO NOTHING`,
  );
  const ops = emails.map((email) =>
    // display_name defaults to the email local-part, matching what the auth
    // middleware produces on first login; users can rename later.
    stmt.bind(email, email.split('@')[0], now, now),
  );
  await env.DB.batch(ops);
}

export async function syncRoster(env: Env): Promise<RosterSyncResult> {
  const missing = (['CF_API_TOKEN', 'CF_ACCOUNT_ID', 'ACCESS_APP_ID', 'ROSTER_CSV_URL'] as const)
    .filter((k) => !env[k]);
  if (missing.length) {
    throw new Error(`roster-sync missing env: ${missing.join(', ')}`);
  }

  const roster = await fetchRoster(env.ROSTER_CSV_URL!);
  const admins = (env.ADMIN_EMAILS ?? '').split(',').map((e) => e.trim()).filter(Boolean);
  const merged = uniqLower([...admins, ...roster]);

  const appPath = `/accounts/${env.CF_ACCOUNT_ID}/access/apps/${env.ACCESS_APP_ID}/policies`;
  const policies = await cf<any[]>(env, 'GET', appPath);
  const policy = policies.find((p) => p.name === 'Allowed users');
  const include = merged.map((email) => ({ email: { email } }));

  let policyId: string;
  if (policy) {
    await cf(env, 'PUT', `${appPath}/${policy.id}`, {
      name: 'Allowed users',
      decision: 'allow',
      include,
    });
    policyId = policy.id;
  } else {
    const created = await cf<{ id: string }>(env, 'POST', appPath, {
      name: 'Allowed users',
      decision: 'allow',
      include,
    });
    policyId = created.id;
  }

  await seedUsers(env, merged);

  return { roster: roster.length, admins: admins.length, merged: merged.length, policyId, emails: merged };
}

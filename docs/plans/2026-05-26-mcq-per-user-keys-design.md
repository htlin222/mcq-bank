# MCQ skill — per-user keys + self-serve `.skill` download

**Date:** 2026-05-26
**Supersedes the auth half of:** `2026-05-26-mcq-skill-api-design.md` (which used
one shared `MCQ_API_KEY`).

## Problem

The `/mcq` Claude Code skill hit `/api/mcq/:id` with a **single shared key**
distributed out-of-band to all ~20 members, plus a self-asserted
`X-User-Email`. One shared secret means no per-user revocation, no audit
granularity, and manual `.env` editing on every member's machine.

## Goal

Each member gets their **own** key and can self-serve a personalised
`.skill` (with `.env` baked in) from `https://<host>/profile` — no manual
config, no admin in the loop.

## Decisions (brainstormed with owner)

1. **Key model — HMAC-derived, nothing secret stored in D1.**
   ```
   key = "mcqk_" + base64url(HMAC-SHA256(MCQ_KEY_SECRET, `${email}:${version}`))
   ```
   - `MCQ_KEY_SECRET`: one global Worker secret.
   - `users.mcq_key_version`: per-user rotation **salt** (default 1) — *not*
     a secret; leaking the DB leaks no keys.
   - Pure function of `(secret, email, version)` → the worker reproduces any
     member's key on demand for both validation and re-download. Re-downloading
     the `.skill` is idempotent (same key) until the user rotates.
   - Rejected: random-key-in-D1 (secret at rest) and hashed-show-once
     (can't re-serve the same `.skill`).

2. **Cutover — hard switch.** Drop shared-key support entirely; the
   middleware only accepts per-user keys. Members re-download once.

3. **Profile UI — download + rotate.** A "下載我的 .skill" button and a
   "重新產生金鑰" button (bumps `mcq_key_version`, invalidating old downloads).

## Implementation

| Area | Change |
|------|--------|
| Migration | `0013_mcq_key_version.sql` — `ALTER TABLE users ADD COLUMN mcq_key_version INTEGER NOT NULL DEFAULT 1` |
| `worker/types.ts` | `MCQ_API_KEY?` → `MCQ_KEY_SECRET?`; `User.mcq_key_version` |
| `worker/lib/apikey.ts` | export `deriveMcqKey(secret,email,version)`; middleware looks up the row's version, recomputes, `timingSafeEqual`. 400 (missing) / 403 (not in allowlist) / 401 (key mismatch) / 503 (secret unset) |
| `worker/routes/me.ts` | `GET /mcq-key` `{version,key}`; `POST /mcq-key/rotate` (version++); `GET /mcq-skill` → zips bundle + baked `.env` via `fflate` |
| `scripts/gen-mcq-bundle.mjs` | snapshots `.claude/skills/mcq/{SKILL.md,scripts/get_mcq.py}` → `worker/generated/mcq-bundle.ts` (runs in `pnpm dev`, `predeploy`, `deploy.sh`) so the served bundle never drifts |
| `frontend` | `Me.mcq_key_version`; `McqKeyCard` in `Profile.tsx` (download anchor + rotate + reveal/copy) |
| skill docs | `.env.example` + `SKILL.md` point at `/profile`; 401 hint says "re-download" |

**`.skill` layout** = `zip -r x.skill .` from inside the skill dir → `.env`,
`SKILL.md`, `scripts/get_mcq.py` at the archive **root** (matches
publish-the-skill / `npx skills add`). `MCQ_API_BASE` is taken from the
request origin, so the baked base is always correct for the host the member
downloaded from.

## Rollout

1. `wrangler d1 migrations apply <db> --remote`
2. Set the secret (one time):
   ```bash
   openssl rand -base64 48 | tr -d '\n' | wrangler secret put MCQ_KEY_SECRET
   ```
3. (Optional) remove the now-unused shared secret: `wrangler secret delete MCQ_API_KEY`
4. `./scripts/deploy.sh` (regenerates the bundle, deploys).
5. Announce: **"Go to /profile → MCQ 小測驗金鑰 → 下載我的 .skill, reinstall it."**
   The old shared key now 401s.

## Verification (done locally, 2026-05-26)

`wrangler dev` + local D1: create user → download `.skill` → unzip (3 files at
root) → baked key → `GET /api/mcq/100-002` **200**; bogus key **401**; unknown
email **403**; rotate → old key **401**, new key **200**; `GET /mcq-key`
reproduces the current key. Ran the actual `get_mcq.py` from the downloaded
bundle (quiz mode + `--answer`) → correct output.

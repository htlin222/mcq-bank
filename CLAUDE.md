# CLAUDE.md

This file gives future Claude sessions the context needed to work on this codebase effectively.

## When the user says "setup" or "deploy" on a fresh clone

Treat this as a request for end-to-end guided onboarding. Walk the user
through the steps below one at a time. Confirm prerequisites first, then
ask before each step that modifies remote resources. **Don't batch — pause
for the user's "ok / done / next" after each numbered block.** If a step
fails, stop and debug; don't paper over with retries.

### 0 — Sanity check (read silently, no need to print)
- `git rev-parse --show-toplevel` → confirms repo root
- `which wrangler pnpm node python3` → all required
- `node -v` ≥ 20, `python3 --version` ≥ 3.11 (for stdlib `tomllib`)
- Look for existing `config.toml` / `wrangler.toml` / `.env` — if any
  exist already, ask the user whether they want to reuse, edit, or
  overwrite (`./scripts/setup.sh --force` overwrites all three).

### 1 — Interactive config
Run `./scripts/setup.sh`. It prompts for:
- **Slug** — drives D1 db, R2 bucket, Worker, Pages project names. Must
  be lowercase + hyphens. Stable: changing later means renaming CF resources.
- **Public host** — e.g. `qa.example.com`. Must already exist as a zone
  in the user's Cloudflare account, or be a `*.pages.dev` they'll switch to.
- **Admin email** — granted in-app admin rights. Becomes `X-Dev-Email`
  for local dev and the seed CF Access user.
- **GitHub repo for feedback button** — set `GH_FEEDBACK_TOKEN` in `.env`
  later (a PAT with `issues:write` on that repo).
- **Exam date** — drives the homepage countdown; can be any future date.

After this step, `config.toml`, `wrangler.toml`, `.env` all exist (with
`<REPLACE_ME_DB_ID>` placeholder that `deploy.sh` will fill in).

### 2 — Install deps + local verification
```bash
pnpm install
cd frontend && pnpm install && cd ..
pnpm db:migrate:local
pnpm dev                                    # terminal A: wrangler dev
(cd frontend && pnpm dev)                   # terminal B: vite
```
Open `http://localhost:5173`. The Vite proxy injects `X-Dev-Email` and
the Worker treats `CF_ACCESS_TEAM_DOMAIN === 'localhost'` as bypass. You
should see the landing page, be able to log in as the dev_email, and
land in the home dashboard. If anything is broken here, **don't proceed
to deploy** — fix locally first.

### 3 — Cloudflare prerequisites (manual, in the dashboard)
Before deploying, the user needs:
- A **Cloudflare account** (free tier).
- An **API token** with scopes listed in `.env.example` (Workers Scripts
  Edit, D1 Edit, R2 Edit, Access Apps+Policies Edit, Pages Edit, Access
  Organizations/IdP/Groups Read; Zone scopes: DNS Edit, Workers Routes Edit).
- **Zero Trust** enabled at https://one.dash.cloudflare.com/ (free plan
  is fine; first-time setup will ask for a team subdomain).
- If using a custom domain (not `*.pages.dev`), the zone must be on CF.

The user puts the token + account ID into `.env` (setup.sh did this if
they answered the prompts).

### 4 — Roster
The deployment whitelists users via a Google Sheet CSV export
(`ROSTER_CSV_URL` in `.env`). For initial deploy, the user can leave it
blank — `admin_emails` from `config.toml` will be the sole allowlist.
For a real cohort:
- Make a sheet with an email column (currently expected at column
  index 3 — see `scripts/sync-access.ts:194`; adjust there for a
  different sheet shape).
- File → Share → Publish to web → CSV → copy the link into `.env`.

### 5 — First deploy
```bash
./scripts/deploy.sh
```
Creates the D1 database (and patches `database_id` into `wrangler.toml`),
applies migrations, creates the R2 bucket, syncs the Access roster,
deploys the Worker, builds + deploys the Pages frontend. Idempotent.

If it stops with an error, read the context — usually a missing scope on
the API token, a zone the account doesn't own, or a name collision.
Don't suggest skipping steps.

### 6 — Cloudflare Access setup
```bash
node --experimental-strip-types scripts/sync-access.ts
```
Creates the CF Access Application at `PAGES_DOMAIN`, sets the policy
include[] from merged `ADMIN_EMAILS` + roster, pushes
`CF_ACCESS_TEAM_DOMAIN` + `CF_ACCESS_AUD` as Worker secrets, and seeds
`users` rows so everyone shows up in @mention pickers before first login.

Then `./scripts/setup-public-bypass.sh` creates path-scoped bypass apps
for the landing page, OG image, favicon, SPA assets, and the auth probe
— so the public can reach the landing without an Access prompt.

### 7 — Import questions
The user provides a CSV (see `scripts/sample-questions.csv` for format).
```bash
node --experimental-strip-types scripts/import-questions.ts ./questions.csv
```
Pre-flight validates year range / group constraints / unique IDs before
any insert — a single failure aborts the whole batch.

### 8 — Smoke test
Have the user open `https://<their host>/`, click "登入" / "Sign in",
receive an email OTP from CF Access, and confirm they land in the
in-app home dashboard with the admin badge. Also verify:
- Creating an explanation on a question (lock + save flow)
- Posting a comment with an @mention (notification badge)
- Uploading an image (R2 + `/img/<key>` proxy)
- Starting a mock exam and submitting

If any of those fail, that's the bug to chase before declaring done.

### Common gotchas (mention if the user hits them)
- `wrangler d1 create` fails with "already exists" — fine, deploy.sh
  handles this; it greps `wrangler d1 list` for the ID.
- Pages domain not resolving — Pages takes a few minutes after first
  deploy; user can use the `*.pages.dev` URL immediately.
- Access "block" page on local dev — `.dev.vars` must have
  `CF_ACCESS_TEAM_DOMAIN=localhost` to enable the bypass.
- `pnpm db:migrate:local` errors about missing `database_id` — fine for
  local (uses `.wrangler/state/`); only `--remote` needs it.
- **Running `deploy.sh` from a git worktree silently ships the frontend
  to a Pages *Preview*, not production.** `wrangler pages deploy` derives
  the environment from the current git branch name, and a worktree is
  never on `main`. The Worker deploys normally (it isn't branch-aware),
  so the result is a live "new Worker + old frontend" split that looks
  like a caching problem. Either deploy from the main checkout on `main`,
  or append `--branch main` to the Pages step. Verify with
  `wrangler pages deployment list --project-name <project>` — the top row
  must say `Production │ main`.
- Freshly deployed frontend not taking effect in the browser — the tab
  can hold a cached `index.html`. A plain reload may reuse it; hard-reload
  (ignore cache) and confirm the served bundle hash matches
  `frontend/dist/index.html` before concluding the deploy failed.

## Configuration model (for any code that touches resource names)

Per-fork values live in `config.toml` (gitignored; the tracked template
is `config.example.toml`). All scripts read from there — never hard-code
a slug, database name, bucket name, host, or admin email.

- **Shell scripts:** `. "$(dirname "$0")/lib/cfg.sh"; v=$(cfg public.host)`
- **Node / TS scripts:** `import { cfg } from './lib/cfg.mjs'; const v = cfg('project.d1_db')`
- **Python scripts:** `import tomllib; CFG = tomllib.load(open('config.toml','rb'))`
- **package.json scripts:** `$(node scripts/lib/cfg.mjs <key.path>)`
- **Worker code:** reads from env bindings declared in `wrangler.toml [vars]`
  (e.g. `ADMIN_EMAILS`, `GH_FEEDBACK_REPO`). Never reads `config.toml` —
  the worker has no FS access at runtime.
- **Frontend code:** values come from `__APP_CONFIG__` (injected by
  `frontend/vite.config.ts` at build time from `config.toml`).

When adding a new per-fork value: add it to `[project]` (or another
relevant section) in **both** `config.toml` and `config.example.toml`,
then read it via the appropriate helper. Don't add a second source of
truth.

## Project Overview

**National exam Q&A study system for 20 internal users.** 1000 questions (10 years × 100/year), with two study modes:

1. **複習模式 (Review)** - one question at a time, immediate answer reveal, collaborative wiki-style 詳解 (explanation), threaded discussion comments
2. **全真作答 (Mock Exam)** - sequential 100-question timed exam simulating real conditions, with score + error review

The whole stack runs on Cloudflare's free tier. Designed for **internal study group**, not public scale.

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  Cloudflare Access (Zero Trust)                              │
│  ↳ Whitelist 20 emails, OTP login, no passwords              │
│  ↳ Injects Cf-Access-Jwt-Assertion header into every request │
└──────────────────────────────────────────────────────────────┘
            │                              │
            ▼                              ▼
┌───────────────────────┐    ┌────────────────────────────────┐
│  Pages (frontend)     │    │  Worker (API, /api/* + /img/*) │
│  - React 18 + Vite    │    │  - Hono framework              │
│  - TypeScript         │◀──▶│  - Verifies Access JWT         │
│  - TailwindCSS        │    │  - All business logic          │
│  - TipTap editor      │    └────────────────────────────────┘
└───────────────────────┘                  │
                                           ▼
                                ┌──────────────────────────┐
                                │  D1 (SQLite)             │
                                │  R2 (image uploads)      │
                                │  Workers AI (optional)   │
                                └──────────────────────────┘
```

## Key Design Decisions

### Auth: Zero Trust, no app-level auth code

We **do not** implement password/OAuth/session logic. Cloudflare Access sits in front, verifies user identity, and forwards a signed JWT in the `Cf-Access-Jwt-Assertion` header. The Worker:

1. Verifies the JWT signature against CF's public keys (cached)
2. Extracts `email` from the payload
3. Upserts the user row on first request
4. Uses email as the user's stable identity throughout

If you're tempted to add app-level signup or password reset — **don't**. That's the wrong layer.

### Storage: TipTap JSON, not HTML

`explanations.content_json` and `comments.content_json` store **TipTap ProseMirror JSON**, not HTML.

Why:
- Zero XSS risk when rendered through TipTap in read-only mode
- Future-proof for Yjs CRDT migration (Yjs uses the same doc model)
- Structured queries possible (count words, extract mentions, etc.)

When you need to display, use TipTap's `<EditorContent editor={readOnlyEditor}>` with the same extension set. Never `dangerouslySetInnerHTML` from these fields.

### Collaboration: Pessimistic lock, not CRDT (yet)

The `explanations` table has `editing_by` and `editing_until` columns. The flow:

1. User clicks "編輯" → `POST /api/questions/:id/explanation/lock` → server checks lock status, sets `editing_by = email`, `editing_until = now + 5min`
2. Frontend renews lock every 60s while editing (`POST .../lock` again)
3. On save → optimistic `version` check + clear lock
4. Other users see "XXX 正在編輯…" badge and read-only view

**This is intentionally NOT real-time CRDT.** For 20 users on 1000 questions, real-time共編 is over-engineering. When/if upgrade is needed, swap the lock UI for a Yjs binding to TipTap and run a Durable Object per question_id. The D1 schema doesn't change — DO storage holds the live Y.Doc, periodic snapshot writes back to `explanations.content_json`.

### Comments: Threaded with @mentions

`comments.parent_id` allows nesting. UI shows a flat-ish tree (2 levels visible, deeper collapsed).

`@username` mentions are extracted server-side from the TipTap JSON (walk the doc, find `mention` nodes), written to `mentions` table, and trigger rows in `notifications`. No real-time push — users see badges on next page load. Adequate for this use case.

### 聊天大廳: one Durable Object room over WebSocket Hibernation

`worker/chat-room.ts` is a SQLite-backed Durable Object (`CHAT` binding,
`idFromName("lobby")`) — **free plan compatible** since DOs with
`new_sqlite_classes` don't need Workers Paid. Messages are plain text
(not TipTap) stored in the DO's own SQLite, trimmed to the last 500;
D1 is only touched to validate mention emails and to write
`notifications` rows (kind=`chat_mention`) for mentioned users who are
not currently connected. Reactions (fixed emoji palette, mirrored in
`frontend/src/chat/ChatProvider.tsx`), reply snapshots, `@all`, and
`@114-010` question links ride the same WS protocol — see
`docs/plans/2026-07-10-chat-lobby-design.md`.

Frontend: `ChatProvider` holds one app-wide WS connection (toasts work
on every page); toast preference lives in `users.chat_notify`
(`all`/`mention`/`off`), editable from the chat page header.

### 作答歷史: `attempts` is the source of truth

`attempts` (migration `0023`) is an append-only event log — one row per
answer, with `source` (`review`/`exam`/`drill`/`anki`), optional
`session_id`, and client-measured `elapsed_ms` (server-clamped by
`clampElapsedMs` in `worker/lib/attempts.ts`).

- **`review_progress` is a derived cache.** `times_seen / times_correct /
  last_*` are all recomputable from `attempts`. It's still dual-written
  (and always will be) because it *also* carries `bookmarked` /
  `bookmark_folder_id`, which are NOT derived. On drift, recompute from
  `attempts` and overwrite `review_progress` — never the other way.
- **`exam_answers` stays the mock exam's current answer state** (mutable,
  for resume + scoring). It is not history; every write also appends to
  `attempts`.
- **New features read `attempts`.** Writes go through `insertAttemptOp`
  batched with the aggregate write, so the two can't diverge mid-flight.
- **History was not backfilled.** Pre-0023 data only ever had aggregates;
  expanding `times_seen=5` into 5 fabricated timestamps would poison the
  source of truth. Older days show no timing and no heatmap counts.

Reconciliation query, if drift is ever suspected:

```sql
SELECT rp.user_email, rp.question_id, rp.times_seen, COUNT(a.id) AS attempts_n
FROM review_progress rp
LEFT JOIN attempts a ON a.user_email = rp.user_email AND a.question_id = rp.question_id
WHERE rp.last_seen_at > <0023 套用時間>   -- 更早的資料必然不等(未回填)
GROUP BY rp.user_email, rp.question_id
HAVING rp.times_seen <> attempts_n LIMIT 20;
```

### PWA: offline *reading* only, and the Access trap

`frontend/src/sw.ts` (built by `vite-plugin-pwa` in **`injectManifest`** mode)
precaches the app shell and runtime-caches an **allowlist** of read-only GET
endpoints. There is no offline write path — no outbox, no background sync.
Write UI is disabled while `navigator.onLine` is false.

The one thing to understand before touching any of this: **an expired
Cloudflare Access session is answered by the edge with a 302 to the login
page, not by the Worker.** `fetch()` follows it, so the response looks like
`status === 200`, `res.ok === true`, with `text/html` from
`*.cloudflareaccess.com`. Caching that gives every user a permanently cached
login page served by a SW that never hits the network again — unrecoverable
without clearing site data. So:

- Cacheability is decided by `frontend/src/lib/sw-guards.ts`
  (`res.redirected` / cross-origin `res.url` / `opaqueredirect` / 401 / 403 /
  content-type), **never by status**. Workbox's `cacheableResponse` plugin
  only sees status and cannot detect this — hence the hand-written
  `cacheWillUpdate`. Unit tests live next to it.
- Navigation is `NetworkOnly` + `setCatchHandler` → precached `index.html`.
  Do **not** switch to `generateSW`/`navigateFallback`: its cache-first
  navigation is exactly the trap above.
- `frontend/src/lib/api.ts` repeats the check for the non-SW path.
- `/manifest.webmanifest`, `/sw.js`, `/icons/*` are Access-**bypassed**
  (`scripts/setup-public-bypass.sh`) — install and SW update checks happen
  without a session, and a 302 there kills the install prompt and pins users
  to the old worker forever.

**Kill switch.** `frontend/public/sw-kill.js` unregisters the worker and drops
all caches. Deploy it as `/sw.js` (`cp frontend/public/sw-kill.js
frontend/public/sw.js`, rebuild, redeploy Pages) and every client self-heals on
next open. A Pages rollback alone does **not** remove a registered SW.

Adding an endpoint to the runtime cache means editing `CACHEABLE_API` in
`sw-guards.ts`. `/api/me`, notifications, chat, exam, review/drill scheduling,
highlights and `/pdf/*` must stay out — see the comment block there for why.

### Images: R2 via Worker proxy (not public bucket)

Uploads: `POST /api/upload` (multipart) → Worker validates size/MIME → R2 put with UUID key → returns `/img/<key>` URL.

Reads: `GET /img/:key` → Worker checks Access JWT (CF Access has already done this for us) → R2 get → stream back with cache headers.

**Never make the R2 bucket public.** Otherwise image URLs leak content to anyone with the URL. Worker proxy preserves Zero Trust boundary.

## File Layout

```
qa-system/
├── README.md              # User-facing setup guide
├── CLAUDE.md              # This file
├── wrangler.toml          # Worker config (D1/R2/AI bindings)
├── package.json           # Worker deps
├── tsconfig.json
├── migrations/            # D1 schema migrations
│   ├── 0001_initial_schema.sql
│   └── 0002_sample_data.sql
├── scripts/
│   ├── deploy.sh                # End-to-end deploy
│   ├── setup-access.sh          # CF Access via API
│   ├── import-questions.ts      # CSV → D1 bulk import
│   └── sample-questions.csv
├── worker/                # Cloudflare Worker (Hono)
│   ├── index.ts           # Entry, route registration
│   ├── types.ts           # Env bindings, shared types
│   ├── lib/
│   │   ├── auth.ts        # Access JWT verification + user upsert
│   │   ├── db.ts          # Typed D1 query helpers
│   │   └── locks.ts       # Pessimistic lock logic
│   └── routes/
│       ├── me.ts          # Current user profile
│       ├── questions.ts   # Question CRUD + list/search
│       ├── explanations.ts # Lock/save/history
│       ├── comments.ts    # Thread CRUD + mentions
│       ├── upload.ts      # R2 image upload
│       ├── images.ts      # R2 image proxy
│       ├── exam.ts        # Mock exam sessions
│       ├── review.ts      # Review progress tracking
│       └── ai.ts          # Workers AI features
└── frontend/              # React + Vite
    ├── index.html
    ├── vite.config.ts
    ├── package.json
    ├── tailwind.config.js
    └── src/
        ├── main.tsx
        ├── App.tsx        # Router + global layout
        ├── routes/
        │   ├── Home.tsx
        │   ├── Review.tsx       # 複習模式
        │   ├── Exam.tsx         # 全真作答
        │   ├── Question.tsx     # Single question detail
        │   ├── ExamResult.tsx
        │   └── Profile.tsx
        ├── components/
        │   ├── Editor.tsx              # TipTap wrapper
        │   ├── ReadOnlyEditor.tsx
        │   ├── CommentThread.tsx
        │   ├── ImageUpload.tsx
        │   ├── QuestionCard.tsx
        │   ├── Avatar.tsx
        │   └── MentionList.tsx         # @-picker popup
        ├── hooks/
        │   ├── useMe.ts
        │   ├── useQuestion.ts
        │   ├── useLock.ts              # Auto-renew explanation lock
        │   └── useUsers.ts             # For mention picker
        └── lib/
            ├── api.ts                  # fetch wrapper
            └── tiptap-extensions.ts    # Shared extension config
```

## Common Tasks

### Add a new API endpoint

1. Create handler in `worker/routes/<area>.ts`
2. Register in `worker/index.ts`
3. Always extract user via `c.var.email` (set by auth middleware)
4. Use `c.env.DB` (D1) and `c.env.R2` (R2) bindings

### Add a TipTap extension

1. Add to `frontend/src/lib/tiptap-extensions.ts`
2. Both editable and read-only editors share this list
3. If the extension stores data in nodes (e.g., custom embeds), make sure server-side render/parse handles it

### Add a D1 migration

```bash
wrangler d1 migrations create qa-db <name>
# Edit the generated file
wrangler d1 migrations apply qa-db --local    # test locally first
wrangler d1 migrations apply qa-db --remote   # then prod
```

**Never edit applied migrations** — create a new one.

### Run AI inference

`c.env.AI.run('@cf/meta/llama-3.1-8b-instruct', { messages: [...] })`

Free tier is 10K neurons/day. Heavy use:
- Cache aggressively (KV namespace exists for this)
- Move to async pattern (queue → process)
- Or upgrade to Workers Paid ($5/mo)

## Things To Avoid

- **localStorage for app state** — Access provides session via cookie, use `/api/me` to fetch state
- **App-level auth code** — Cloudflare Access handles it
- **Public R2 buckets** — defeats Zero Trust
- **HTML in DB** — store TipTap JSON, render through TipTap
- **Editing applied migrations** — create new ones
- **Generic AI-styled UI** — see `frontend-design` notes below

## Frontend Design Notes

The UI aesthetic is **scholarly/editorial**, not generic SaaS. Specifically:

- All-sans typography (Inter + Noto Sans TC) — the owner dropped the earlier
  serif headings in 2026-07; `font-serif` in Tailwind is aliased to the sans
  stack, so don't reintroduce real serif fonts
- Restrained color palette: ink/cream/single accent
- Comfortable reading width, generous line-height for long 詳解 content
- Mobile-first but desktop-respecting (long-form reading benefits from wide screens)
- No purple gradients, no glassmorphism, no excessive shadow

When extending the UI, preserve this voice. It's a serious study tool — looks should match.

## Testing & Debugging

- Local D1 lives at `.wrangler/state/v3/d1/`
- Wipe local DB: `rm -rf .wrangler/state`
- View D1 contents: `wrangler d1 execute qa-db --local --command "SELECT * FROM questions LIMIT 5"`
- Wrangler tail prod logs: `wrangler tail`
- Pages logs: dashboard → Pages → project → Functions tab

## Cost Awareness

This is designed to fit in **free tier indefinitely** for 20 users. If a feature would push past free tier, call it out explicitly. Don't silently add paid services. Note: SQLite-backed Durable Objects (`new_sqlite_classes`) ARE available on the free plan (the chat lobby uses one) — only KV-backed DO storage requires Workers Paid.

## Owner Notes

- Original spec from user: 1000 題, 10 年, 共筆詳解, 留言討論, @mention, 全真模擬, RWD, all Cloudflare
- AI features are optional add-ons, not core
- Future migration path to真共編 is reserved but not implemented

# Design — `/mcq` read-only question API + distributable skill

**Date:** 2026-05-26
**Status:** Approved (brainstorm complete), ready for implementation

## Goal

Let study-group members fetch a single exam question (stem, options, answer,
collaborative 詳解) from inside Claude Code by typing `/mcq 114-001`, without
giving them a Cloudflare Access session. A repo-local skill runs a Python
script that calls a new read-only API endpoint on the existing Worker.

`114-001` maps **directly** to the `questions` primary key (`id = "114-001"`,
民國年 stored as-is, 3-digit zero-padded number) — no year conversion.

## Decisions (locked)

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Access model | Read-only, ~20 members, **single shared key** | Simplest gate for a trusted cohort |
| Architecture | **A** — new route in existing Worker, bypass Access, self-verify key | One deploy, reuses `c.env.DB`; no second Worker |
| Key compare | **timing-safe** (SHA-256 + `crypto.subtle.timingSafeEqual`) | Avoid timing leak; Workers-native |
| Email layer | **A1** — `X-User-Email` checked against `users` allowlist; logged | Audit + soft revocation. NOT a crypto 2nd factor (email is self-asserted, not Access-verified) |
| Skill scope | **repo-local** `.claude/skills/mcq/`, key in gitignored `.env` | No secrets in distributed files |
| Packaging | GitHub Action → `.skill` (renamed zip) → GitHub Release on push | Versioned distribution |
| Provisioning | **all CLI** — `wrangler` for secret/deploy, CF API curl for Access bypass | No dashboard/GUI |

## 1. Worker — auth middleware (security core)

New `worker/lib/apikey.ts`. Registered in `worker/index.ts` **before**
`app.use('/api/*', authMiddleware)` so it does NOT inherit Access auth:

```ts
async function safeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [ah, bh] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(ah, bh); // constant-time, fixed 32-byte len
}

export const apiKeyMiddleware: MiddlewareHandler<AppContext> = async (c, next) => {
  const auth = c.req.header('Authorization') ?? '';
  const presented = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const email = (c.req.header('X-User-Email') ?? '').trim().toLowerCase();

  if (!presented || !(await safeEqual(presented, c.env.MCQ_API_KEY)))
    return c.json({ error: 'unauthorized' }, 401);

  const row = await c.env.DB.prepare('SELECT email FROM users WHERE email = ?')
    .bind(email).first();
  if (!row) return c.json({ error: 'email not in allowlist' }, 403);

  console.log(`[mcq-api] ${email} → ${c.req.path}`);
  c.set('email', email);
  await next();
};
```

Wiring: `app.route('/api/mcq', mcqRoutes)` with `mcqRoutes.use('*', apiKeyMiddleware)`.
Add `MCQ_API_KEY: string;` to the `Env` interface in `worker/types.ts`.

## 2. Worker — response shape + TipTap→markdown

`worker/routes/mcq.ts`, `GET /:id` hits the primary key:

```ts
mcqRoutes.get('/:id', async (c) => {
  const id = c.req.param('id');
  const q = await c.env.DB.prepare(
    `SELECT id, year, number, "group", stem, options_json, answer, difficulty, source
     FROM questions WHERE id = ?`).bind(id).first();
  if (!q) return c.json({ error: 'question not found', id }, 404);

  const exp = await c.env.DB.prepare(
    `SELECT content_json, version, updated_by, updated_at
     FROM explanations WHERE question_id = ?`).bind(id).first();

  return c.json({
    id: q.id, year: q.year, number: q.number, group: q.group,
    difficulty: q.difficulty, source: q.source, stem: q.stem,
    options: JSON.parse(q.options_json as string),
    answer: q.answer,
    explanation: exp ? {
      markdown: tiptapToMarkdown(JSON.parse(exp.content_json as string)),
      version: exp.version, updated_by: exp.updated_by, updated_at: exp.updated_at,
    } : null,
  });
});
```

`tiptapToMarkdown(doc)` walks ProseMirror nodes → markdown:
doc/paragraph/text/heading/bullet+orderedList/listItem/hardBreak/blockquote/
image/mention, unknown nodes fall through to their text content. Collapses
3+ newlines, trims.

**Default payload = question + options + answer + explanation (markdown)** =
"all the info". Comments excluded from v1 (large, tree-shaped); add later via
`?include=comments`. Explanation images stay as `/img/<key>` markdown links
(that path is still Access-gated; fine for terminal display).

## 3. Skill — repo-local layout

```
.claude/skills/mcq/
├── SKILL.md            # frontmatter incl. version: 0.1.0
├── .gitignore          # one line: .env
├── .env.example        # tracked template (cp → .env)
├── .env                # gitignored: MCQ_API_BASE / MCQ_API_KEY / MCQ_USER_EMAIL
└── scripts/
    └── get_mcq.py      # stdlib only (urllib) — no pip install
```

`SKILL.md` tells Claude to run, from repo root:
`python3 .claude/skills/mcq/scripts/get_mcq.py "<id>"`

`get_mcq.py`: parses `.env` (located via `Path(__file__).parent.parent/.env`,
`.env` values win over `os.environ`), normalizes `114-1`→`114-001`, GETs
`{MCQ_API_BASE}/api/mcq/{id}` with `Authorization: Bearer` + `X-User-Email`,
prints stem / options / answer / explanation. On 401/403 prints a hint to
check `.env`.

**Implication:** repo-local skill ⇒ members must check out this repo and open
Claude Code inside it. If wider distribution is needed later, the `.skill`
release artifact (below) is the standalone package.

## 4. GitHub Action — package `.skill` release

`.github/workflows/package-mcq-skill.yml`:
- `on: push` to `main` filtered to `paths: ['.claude/skills/mcq/**']`, plus
  `workflow_dispatch`.
- `permissions: contents: write`.
- Build: `rm -f .env` (belt-and-suspenders — never ship the key), read
  `version:` from `SKILL.md` → `TAG=mcq-v$VER`, zip the `mcq/` folder
  excluding `.env` → `dist/mcq.skill`.
- Release: `gh release delete "$TAG" --yes --cleanup-tag || true` then
  `gh release create "$TAG" dist/mcq.skill` with notes = install steps +
  `head_commit.message`.

Bump `version:` in `SKILL.md` to cut a new release; same version re-push
replaces the existing release.

## 5. Provisioning — all CLI

1. **Secret:**
   ```bash
   KEY=$(openssl rand -base64 32)
   printf '%s' "$KEY" | wrangler secret put MCQ_API_KEY
   echo "$KEY"   # distribute out-of-band to 20 members' .env
   ```
2. **Access bypass** — add to `scripts/setup-public-bypass.sh` `PATHS=()`:
   ```bash
   "/api/mcq/*|${SLUG} public · mcq-api"
   ```
   then `./scripts/setup-public-bypass.sh --dry-run` → `./scripts/setup-public-bypass.sh`.
   `/api/mcq/*` is more specific than the root Access app, so CF matches the
   bypass first; the rest of `/api/*` stays gated.
3. **Deploy:** `wrangler deploy`
4. **Test:**
   - `200`: with `Authorization: Bearer $KEY` + valid `X-User-Email`
   - `401`: no key
   - `403`: valid key, email not in `users`
   - `302`: `curl -sI $H/api/me` (other API still Access-gated)

## Out of scope (YAGNI)

- Per-user derived tokens (A2) — rejected; shared key + email allowlist is enough.
- Rate limiting — trusted 20-person cohort; revisit if abused.
- Write-back (post explanations/comments via skill) — read-only only.
- Comments in payload — deferred behind `?include=comments`.

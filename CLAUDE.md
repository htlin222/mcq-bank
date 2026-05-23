# CLAUDE.md

This file gives future Claude sessions the context needed to work on this codebase effectively.

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

- Serif headings (Source Serif or similar) paired with clean sans body
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

This is designed to fit in **free tier indefinitely** for 20 users. If a feature would push past free tier (e.g., real-time共編 needs Durable Objects = Workers Paid), call it out explicitly. Don't silently add paid services.

## Owner Notes

- Original spec from user: 1000 題, 10 年, 共筆詳解, 留言討論, @mention, 全真模擬, RWD, all Cloudflare
- AI features are optional add-ons, not core
- Future migration path to真共編 is reserved but not implemented

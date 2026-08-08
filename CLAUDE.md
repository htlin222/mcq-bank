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

### 新年份題庫: staged import, and the key that can't publish

複習模式的「＋ 加入新年份」(admins only) 讓管理員不必 clone repo、不必碰
Cloudflare 憑證就能加一屆考題。設計:
`docs/plans/2026-08-06-new-year-ingest-design.md`。

The security shape is the part worth remembering. Two keys, two blast radii:

- `mcqk_` (existing) — read questions. ~20 people carry it.
- `bnkk_` (`worker/lib/bank-key.ts`) — write the **staging area only**. Admins
  only, separate secret (`BANK_KEY_SECRET`), separate version salt.

`/api/bank-ingest/*` is Access-**bypassed** (the caller is a python script on a
laptop with no session) and can only touch `import_jobs` / `import_staging`,
which no student-facing query reads. Promoting a staged year into `questions`
goes through `/api/admin/import-year/:id/publish`, which needs an Access
session plus `ADMIN_EMAILS`. **Never add `/api/admin/*` to
`setup-public-bypass.sh`** — that one line is what makes a stolen laptop
harmless.

Publish is INSERT-only and refuses any year that already has questions. That
isn't tidiness: the CSV importer's upsert had to grow a
`CASE WHEN answer_history IS NULL` guard because a re-import silently clobbered
answers the community had revised through the challenge flow. Refusing existing
years makes that bug class unreachable here rather than guarded against.

**答案是白色的「字」,不是白色的方塊。** 官方 PDF 的答案欄每題都有一個
`color=#ffffff` 的字母 —— 印出來看不見,但文字層有。所以官方發的「題目版」
本身就含答案,不需要答案顯示版;但 `pdftotext` 會把隱藏層與可見層都吐出來、
分不清誰是誰,故解析器(`.claude/skills/bank-ingest/scripts/parse_exam.py`)
用 PyMuPDF 讀 span 顏色。答案欄座標由版面推導,不寫死。實測 114 年兩份官方
PDF 共 100 題全數以信心 1.0 命中。兩個踩過的坑:連鎖題的答案寫成 `(C)` 而非
`C`,以及至少一題用全形 `Ｄ` —— 兩者都會靜默漏題。

The skill is snapshotted into the Worker by `scripts/gen-bank-bundle.mjs` (same
pattern as the mcq bundle) so `/api/me/bank-skill` can zip it with a freshly
baked per-admin `.env`. Editing the skill means re-running `pnpm gen:bundles`
— wired into `dev` and `predeploy`.

### 其他筆記: 不掛題目的私人筆記,以及那張表為什麼要重建

`/lectures?tab=note` 是講義/教科書旁的第三個分頁,每張卡片是一則
**question-agnostic** 的私人筆記(`free_notes`,migration 0040)。設計:
`docs/plans/2026-08-07-free-notes-design.md`。

`personal_notes.question_id` 有 `REFERENCES questions(id)`,所以「用假題號當
佔位」這條路走不通 —— 得先在 `questions` 插一列假題目,而題數統計、隨機出題、
匯出全都是 `SELECT ... FROM questions`。故另開一張表。

真正值得記住的是連帶動的那兩張表。`note_terms` / `note_link_suggestions` 原本
的鍵是 `(user_email, question_id)`,0040 改成 `owner_kind` + `owner_id`
(`'question' | 'free'`),`target_kind` 多一個 `'free'`。**沒有把自由筆記的 id
塞進 `question_id` 欄位**:格式不會撞(`114-001` vs UUID)所以「能動」,但那會
讓欄名說謊,而這兩張表的每一條查詢都靠欄名讀懂。換到的是單一程式路徑 ——
自由筆記與題目筆記互相推薦是同一段 SQL,不是兩套。

- **讀取端不能用單一 `JOIN questions`。** 原本 `notes.ts` 是
  `JOIN questions q ON q.id = s.target_id`,自由筆記目標的 `target_id` 不是
  題號,會被**靜默丟掉** —— 建議少一種來源而且完全無聲。改成依 `target_kind`
  分別 LEFT JOIN(`lib/note-links.ts` 的 `loadSuggestions`),`free` 那條還要
  `AND user_email = ?`,否則會漏出別人的標題。
- **標籤的刪除要留墓碑(`source='hidden'`),不能真的刪列。** AI 重跑是
  `DELETE WHERE source='ai'` + `INSERT OR IGNORE`;真的刪掉的話,模型看同一份
  內容會再給出同一個標籤,使用者刪過的標籤下次打開筆記就又回來了。
- **重跑的判準是內容雜湊(`tagged_hash`),不是髒旗標。** 旗標會被
  「存檔 → 還沒產標籤 → 又存檔回原內容」騙到。
- **寫入端不呼叫 Workers AI。** debounce 存檔一秒好幾次,在那裡叫模型等於把
  免費額度燒在沒人看的中間狀態上。產生點在 `GET /:id/tags`,且與筆記本體分開
  取得,詳情頁才不會為了等標籤空著一兩秒。
- **`/api/free-notes*` 不進 `sw-guards.ts` 的 `CACHEABLE_API`**(有測試鎖著)。
  可變的私人狀態被 SW 快取住,使用者會存完筆記、重整,然後看到自己剛寫的東西
  沒有變 —— 而且無聲。名稱跟可快取的 `/api/lectures` 很像,特別容易誤加。
- 畫記沿用既有機制,`highlights` 一列 schema 都沒動:前綴 `anno:free:<id>`,
  收藏頁「我的畫記」多撈一次 `?prefix=anno:free:`。標題不在 key 裡,所以要併
  著 `listFreeNotes()` 一起拿;查不到標題就整組略過(筆記已刪)。
- 連到題目的 `@114-010` **一行新程式都沒有** —— `RichEditor` 用的
  `buildExtensions()` 本來就含 `QuestionRef` 與 mention suggestion。

### 2048: 純休息,而且刻意跟題庫零耦合

`/play` 是個休息小遊戲(設計:
`docs/plans/2026-08-06-play-2048-design.md`)。入口只在個人頁一個小連結,
不進導覽列。

值得記住的是**它為什麼不跟刷題綁在一起**。「答對才能玩」「合成 512 跳一題」
都想過,但那會讓一個五百行的休息功能長出對 `attempts`、`drill`、計分邏輯的
依賴,往後每次動學習相關的程式都要多想它一次。休息就讓它只是休息。

三層互不知情:`frontend/src/lib/game2048.ts` 是純函式引擎(rng 由呼叫端注入,
所以「新磚落在哪」在測試裡可決定)、`frontend/src/routes/Play.tsx` 只管輸入與
畫面、`worker/play-2048.ts` 的 DO 只管存檔。資料流單向,**DO 從不回推**。

- **存檔用獨立的 `Play2048` DO,不是塞進 `UserState`。** DO 是單執行緒的:
  遊戲每步 debounce 寫入(秒級),續讀位置換頁才寫(分鐘級)。塞在同一個
  instance,等於讓有人在玩時,其他人的「上次停在哪」排在遊戲寫入後面。
- **`best` 由 DO 取 `MAX(舊, 新)`**,client 送什麼都不能讓最高分變小,開新局
  也不歸零。
- **驗證只防資料汙染,不防作弊**(`worker/lib/play-state.ts`)。要真的防作弊得
  在 server 重放整局移動;對 20 個熟人的休息遊戲那是過度設計,而且會把一個
  零耦合的功能變成有狀態機的功能。
- 榜單的 D1 join 在**路由層**做(DO 只認得 email),DO 不碰 D1。
- **`/api/play` 不在 `sw-guards.ts` 的 `CACHEABLE_API`** —— 可變狀態被 SW
  快取住,玩家會永遠看到停在舊局的棋盤。

部署提醒:`wrangler.toml` 是 gitignored 的產出物,新增的 `PLAY` binding 與
`[[migrations]] tag = "v3"` 只進得了 `wrangler.example.toml`。合併後第一次
部署前,要把這兩段手動補進主 checkout 的 `wrangler.toml`,否則 Worker 會因為
找不到 `Play2048` class 而部署失敗。

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

### 換題延遲: 應用層快取 + 預抓,刻意不動 Service Worker

設計: `docs/plans/2026-08-07-question-nav-latency-design.md`。

「按下一題要等一下」原本是四個成因疊在一起,其中最痛的不是慢:**舊版
`useQuestion` 的 `data` 不隨 id 清空**,而 `/q/:id` 沒有 `key` 所以元件不重掛
—— 使用者按下下一題後,會盯著**上一題**的題幹與已揭曉的答案好幾百毫秒。看起來
像沒點到。現在資料連同「屬於哪一題」一起存,只在 `entry.id === id` 時才算數。

- **`frontend/src/lib/questionStore.ts`** 是一個 LRU + in-flight 去重的 store,
  存在的理由只有一個:`peek()` 在 **render 當下同步**可讀,所以預抓命中時第一次
  render 就畫得出完整題目,連 loading 都不進。TTL 60s,過期不丟(先畫舊的再背景
  重抓)。
- **`useQuestion` 結尾那個 render 期間的 `questionCache.peek(id)` 是承重的,不是
  順手優化。** 拿掉它,換題的第一個 render 必然 `data === null`(state 還停在上一
  題,effect 來不及),`Question.tsx` 的 `if (!data)` 就會把整棵子樹卸掉一幀再重掛
  —— TipTap 被重建,GamepadFab 的「已連線」提示也會每次換題重播一次。
- **一次性的提示不要把「講過了沒」記在元件 state。** `GamepadFab` 掛在
  Question / YearList / Exam 三條路由上,換頁一定重掛;`claimConnectionAnnouncement()`
  (`lib/gamepad.ts`)把它記在模組層並綁在 pad id 上,拔插才會重新宣告。
- **不要把 `/api/questions/:id` 在 `sw.ts` 改成 StaleWhileRevalidate。** 它會讓
  「存完詳解 → `reload()` 看到自己的修改」讀到舊值 —— 比慢更糟。快取因此做在應用
  層,失效時機由呼叫端掌握(存檔後 `set()`、`reload()` 走 `force`)。SW 那套
  Access-redirect 防護一行未動。
- **換題的視覺回饋用 WAAPI (`element.animate`),不要用 `key`/remount。** 重掛整棵
  子樹會連 TipTap 一起重建,那正是 2026-07 iOS 白屏的成因(見上面 PWA 那節)。
- 驗證在 `frontend/e2e/nav-prefetch.test.mjs`:fixture 伺服器每個 `/api/` 延遲
  700ms,把「有沒有預抓到」變成可觀測的時間差。改動預抓邏輯後這支會紅。

**作答完不要為了「我剛才選了什麼」再問一次伺服器。** 舊版是
`onAnswered={reload}`(強制重抓整份 payload),而 `/api/questions/:id` 在 SW 是
NetworkFirst + **3 秒 timeout** —— 網路一慢,回的是**答題前**那份快取,
`last_chosen` 還是 null,於是「強制重抓」反而把剛作答的狀態洗掉,還會一路
`questionCache.set()` 寫回應用層快取。加上 POST 失敗時 `onAnswered` 根本不會被
呼叫,合起來就是回報 #95 的「上一題/下一題 來回切換,作答紀錄就不見了」。
改成 `lib/questionProgress.ts` 的純函式就地補寫 `my_progress` —— client 手上本來
就有選了哪個、對不對,不需要一趟 RTT 來告訴我們。**收藏欄位要原封不動帶過去**:
它跟作答只是剛好共用同一個物件,漏帶的症狀是「答一題就把收藏取消了」,而且要
重新整理才看得出來。它單獨一個檔案而不是放進 `questionCache.ts`,因為那支會
`import './api'`,整個模組在 `node --test` 底下載不起來。

**`/q/:id` 在 <md 是分頁的,不是堆疊的(#96)。** 一張含五個選項的題目卡就吃掉
一整個手機螢幕,堆疊版等於「看詳解永遠要先捲過整張卡」。手機那層刻意**不**沿用
桌機的 `mainTab`(六個值,每個 pane 一個):右欄頂端那條 詳解共筆/個人筆記/… 的
strip 本來就在而且是 sticky 的,直接當第二層,手機只需要回答「看題目,還是看
題目以外的東西」。兩件事容易漏:**換題要把它重設回題目**(否則從詳解按下一題會
直接落在下一題的詳解上 —— 那是劇透),以及**切換時捲回頂端**(兩個 pane 共用同
一條頁面捲軸)。隱藏只能用 JS 算出來的布林,`md:hidden` 之類的字首寫不出「只在
<md 依狀態隱藏」。

**`createQuestionStore` 是通用的,不只給題目用。** 名字是歷史包袱 —— 它同時是
`/lectures` 三個分頁(`lectureListCache`)與其他筆記清單(`freeNoteListCache`)
的快取。下次再收到「切 X 分頁都要重新載入,蠻卡的」這類回報,先看是不是同一個
病灶:切換時 `setState(null)` 再重抓。套用方式固定三步 ——
render 當下 `peek()` 同步取、`isFresh()` 決定要不要背景重抓、**把失效寫進
API 模組自己的變更函式裡**(`freeNoteApi.ts` 的 `dropListCache()`)而不是交給
呼叫端記得。清單帶著標題之類的可變欄位時,漏掉失效的症狀是「改完名回到清單還是
舊的」,而且無聲。

### 手把: 同一顆鍵在不同情境換意思,而且說明要跟著換

`/q/:id` 的手把綁定分散在兩層:`QuestionCard` 擁有選項游標與送出/複製/收藏,
`Question.tsx` 擁有需要頁面脈絡的那些(換題、換分頁、捲動)。在這之上再疊三種
**情境**,由 `Question.tsx` 判斷後接管:

| 情境 | 條件 | 十字鍵 | 面鍵 |
|---|---|---|---|
| 作答中 | `!cardRevealed` | 選選項 / 調信心 | 送出 · 略過 · 複製 · 收藏 |
| 讀詳解 | `expKeysActive` | 捲動 | 顯示詳解 · 自動挖空 · 防劇透 · 編輯 |
| 讀筆記 | `noteTabVisible` | 走訪標題 / 切換筆記 | 展開收合 |

擴充時的三條規矩:

- **接管前先確認卡片不要那顆鍵,否則一次按鍵會做兩件事。** `FACE ▲ / ▶` 卡片
  無條件吃,所以要靠 `yieldFaceKeys` prop 讓它明確讓出;`FACE ▼ / ◀` 只在未揭曉
  時吃,揭曉後直接接管即可。**一定要等 `cardRevealed`** —— 搶在答題前接管 ▼,
  等於按下送出的同時把詳解也掀開。
- **每種情境一份 `GamepadHint[]`,不要 spread 共用那份再蓋。** 意思被換掉的鍵
  會留下兩行互相矛盾的說明。
- **走訪清單優先問 DOM,不要另外維護狀態。** `NoteContent` 的每個手風琴各自持有
  `open`(刻意的:巢狀、彼此獨立),而收合的區段不渲染子節點 —— 所以
  `[data-note-heading]` 查到的按鈕,定義上就是使用者現在看得到的那些。焦點環用
  `:focus` 而非 `:focus-visible`:程式呼叫 `.focus()` 不一定被判定成
  focus-visible,那樣游標是隱形的。

驗證都在 `frontend/e2e/gamepad.test.mjs`(假 `navigator.getGamepads`)。**寫這裡
的測試要驗正面效果,不要驗「某個副作用沒發生」** —— 後者在功能根本沒接上時也會
通過。真的踩過:「FACE ▶ 之後收藏狀態不變」在功能停用時照樣綠,因為那顆鍵落回
卡片的收藏,而 fixture 的收藏 API 回空物件、狀態本來就不會動。**確認新測試會紅
的時候不要用 `pnpm build >/dev/null 2>&1`** —— 建置失敗被吃掉,測試會跑在舊
bundle 上,得到「停用了還是綠」的假結論。

### 讀書計畫產生器: 排程是純函式,AI 只負責語氣

首頁倒數卡片右側的「生成讀書計畫」開一個對話式問卷(七題),產出到考試當天的
逐日計畫表(單檔 HTML)與可匯入行事曆的 `.ics`。設計:
`docs/plans/2026-08-07-study-plan-generator-design.md`。

跟 `PacingCard` 的分工要先講清楚,不然日後會有人想把兩者合併:`PacingCard`
是後視鏡(「以我**目前**的速度做得完嗎」,輸入全來自 `attempts` 的既成事實);
這裡是前瞻(「我**打算**每天 90 分鐘、只寫五年、跑兩輪,排得出來嗎」,輸入是
意圖)。天數兩邊都取 `/api/review/readiness` 的 `days_left`(ceil),不混用首頁
倒數卡的 `countdown.days`(floor)—— 差一天,同畫面兩個數字是體感 bug。

- **`worker/lib/study-plan.ts` 的 `buildPlan()` 是純函式**,不碰 D1、不碰
  `Date.now()`。前端不重算排程,只顯示 `/api/study-plan/preview` 回來的結果 ——
  兩邊各算一次必然會在某個邊界條件上算出不同數字。
- **第二輪起只排錯題(× 錯誤率遞減),不重跑全題。** 若每輪都排全題,「剩 28 天
  跑兩輪 1000 題」會算出一天 71 題 —— 那不是計畫,是一張看一眼就關掉的表。
- **排不完就說排不完。** `shortfall` 帶著差額回傳,UI 與 HTML 都把它放在所有
  表格**之前**,並附三顆一鍵重算的按鈕(加時間 / 砍最舊年份 / 減一輪)。那句話
  是使用者現在就該做決定的唯一理由,被行事曆推到看不見的地方等於沒說。
- **`study_plans` 只存問卷輸入,不存排程結果**(migration `0039`)。排程可從
  「輸入 + 當下進度」重算,存下來就會跟真實進度漂移,而漂移的計畫表沒人會發現
  它錯了。同 `review_progress` 是快取、`attempts` 才是真相的那條規則。
- **弱點不走 `/api/review/weakness-map`** —— 它依賴 Vectorize 索引,未回填時直接
  回空陣列,拿它當計畫的基礎會在多數使用者身上開天窗。改用逐年正確率 +
  `tag_topics`/`video_topics` 白名單的確定性 SQL,並濾掉作答數 < 8 的主題
  (「1 題錯 1 題 = 0%」是雜訊,不是弱點)。
- **Workers AI 只寫弱點導讀那一段,不碰任何一個數字。** 送出去的只有一張最多
  12 列的彙總表,不含題目內容也不含 email;6 秒 timeout,失敗整段省略,計畫表
  照出。export 的導讀文字由 client 帶回而不是再打一次 AI —— 同一份計畫燒兩次
  神經元,還可能拿到兩段不一樣的文字。
- **真 PDF 是 non-goal**,理由同 `export-html.ts`:Browser Rendering 要付費、
  CJK 字型塞不進 bundle、從 R2 拉字型再 subset 撐不住 free plan 的 10ms CPU。
  HTML 帶 `@media print` 與一顆列印時自己隱藏的按鈕,瀏覽器列印的輸出跟真 PDF
  沒有差別。
- **`.ics` 用定時事件而非全天事件**(考試當天除外 —— 不知道幾點入場)。手機只有
  定時事件才會跳提醒,而不會提醒的計畫表不會被執行。跨午夜的時段(23:30–01:00、
  21:00 起的三小時模擬考)**必須把日期一起進位**;只取 `mod 1440` 會產出「開始
  21:00、結束同日 00:00」的負長度事件 —— 這個 bug 單元測試沒抓到,是實際產一份
  `.ics` 出來看才發現的。
- **`/api/study-plan` 不在 `sw-guards.ts` 的 `CACHEABLE_API`** —— 可變狀態被 SW
  快取住,使用者會看到上一版的計畫還以為沒存到。
- 驗證:`worker/lib/study-plan*.test.ts`(排程 / HTML / ICS),以及
  `frontend/e2e/study-plan.test.mjs` —— 這個功能整個活在 portal 掛載的 modal 裡,
  `smoke.test.mjs` 只會開路徑、碰不到它。fixture 由
  `scripts/gen-study-plan-fixture.mjs` 跑真的 `buildPlan()` 產出,手寫的 JSON 會
  在 `PlanResult` 改欄位時悄悄過期。

### 電子紙模式: 第四個主題,而且它是一整層 CSS 覆寫,不是一組色票

`ThemeToggle` 的第四態(`light`/`dark`/`eink`/`system`)。狀態抽到
`frontend/src/lib/theme.ts`(localStorage-only,`useIsEink()` 給那些必須改渲染
的元件用)。全站規則寫在 `frontend/src/styles.css` 檔尾一整區。

**`.eink` 絕不同時掛 `.dark`** —— 這是整層的前提,寫在 `applyTheme()` 的註解裡。
`darkMode: 'class'` 只認 `.dark`,所以 e-ink 下全站 1604 處 `dark:` 一律失效、
走 light 那一套,我們只需要中和「一套」配色。兩個 class 同時在的話,那 1604 處
會復活並蓋過中和層。

**沒有把 `ink-*`/`accent` 變數化。** 那條路看起來能讓 3143 處 token 自動跟隨,
但 `ink-200` 既是 `bg-ink-200`(淺底,1-bit 下要白)也是 `border-ink-200`
(分隔線,要黑)—— 一個變數服務不了兩個相反的角色;而且那會動到現有 light/dark
的資料來源,手抄 hex 抄錯一位不會報錯,只會讓某個灰稍微不同。改成**全滅 + 撈回**:
凡 class 名帶 `bg-`/`text-`/`border-`/`fill-`/`ring-`/`outline-` 的一律塗黑白,
再把「純色即語意」的少數(`[class~="bg-accent"]`、`bg-black`)撈回實心黑。
不列舉色系 —— 那份清單會腐爛,而且漏掉 `text-ink-400`(#8a7d65,是灰)。
hover 態不必特別處理:`hover:bg-accent` 是 (0,2,0),打不過中和層的 (0,3,0)。

**Specificity 契約是承重的,不是風格。** Tailwind 的 `@layer` 不是原生 cascade
layer,輸出後就是普通 CSS,**specificity 先於順序**:

| 層 | Specificity |
|---|---|
| 一般 utility / `hover:` | (0,1,0) / (0,2,0) |
| 中和層 `.eink.eink [class*="bg-"]` | (0,3,0) |
| `.eink-invert` 的後代規則 | (0,4,0) |
| `eink:` variant(`tailwind.config.js` 的 `.eink×4 &`) | (0,5,0) |

所有 `:not()` 一律包 `:where()` 讓排除項不加權,整層才停在 (0,3,0)。少了那層
`:where()`,帶兩個 `:not` 的規則會爬到 (0,5,0) 跟 variant 平手,逐元件精修就會
被通則蓋掉 —— 而且是無聲的。**別「順手清理」重複的 `.eink`**。
唯一的例外是 `::placeholder`:它要跟 `placeholder:text-ink-400` 這種 utility
競爭,所以寫成 `.eink.eink ::placeholder`。單個 `.eink` 只能打平,然後輸給檔案
順序 —— 打包後 utilities 排在本區塊**之後**,這點跟直覺相反,實際踩過。

**三個語意 class 在非 eink 主題下沒有任何樣式**,所以元件可以無條件掛著,
light/dark 一個像素都不動:`eink-invert`(整塊反白,含後代文字/圖示轉白)、
`eink-mark-ok` / `eink-mark-bad`(`::before` 補 ✓ / ✗)。後兩者的存在理由是成績頁
那個「85%」—— 及格與否**只**寫在 emerald/rose 裡,數字本身不帶判斷。

**顏色沒了之後,語意要換一個維度重講,而不是擠在同一個維度。** 模擬考題號格是
標準示範:填充(黑/白)= 答了沒、`outline`(畫在框外,黑白填充都疊得上)= 是不是
當前這題、虛線邊 = 有沒有標記。三個正交,所以不會互相蓋掉。同理選項列是
「正解=整列反白 / 答錯=粗框+刪除線 / 其他=細框」,分類 badge 是四種框線語彙
(填充只有兩種,線型有四種)。

**「透明的 utility」不是要中和的對象,是要排除的對象。** `text-transparent` /
`border-transparent` 從一開始就在 `:not(:where(…))` 裡,但同一類的
**`outline-none` 漏了** —— Tailwind 的 `outline-none` 不是 `outline-style: none`,
而是**留給 focus ring 用的 2px 透明外框**。塗黑之後它就憑空長出一個實心黑框:
防劇透那顆 `inset-0` 的按鈕變成回報 #95 說的「奇怪的長方形 overlay」,全站 30 處
`focus:outline-none` 的輸入框一 focus 也各多一個黑框。用 `[class*=]` 排除(不是
`[class~=]`),才連 `focus:` / `md:` 這些前綴變體一起中掉。**顏色掃描抓不到這種
錯**:黑色在 1-bit 下完全合法。所以驗的是反面 —— 掛了 `outline-none` 的元素本來
就不該看得見外框。

**`backdrop-filter: none` 關不到 `filter`。** 防劇透用的是後者(`blur-md`),
於是中和層一路放行,詳解在 e-ink 上糊成一團灰 —— 而灰正是整層在消滅的東西。
改成 `display: none`(不是 `visibility: hidden`:後者讓被遮的詳解照原高度占位,
揭曉前是一大片空白)。選 `[class~="blur-md"]` 而非 `[class*="blur-"]`,否則會連
App bar 的 `backdrop-blur` 一起 `display:none`,整條導覽列消失。

**兩個 getComputedStyle(el) 讀不到、只能靠看畫面抓的破口**(同 `::placeholder`):
`::selection` 的預設反白(半透明藍/灰 —— 選字查教科書、畫螢光每天都會撞到),
以及 `-webkit-tap-highlight-color`(Android 預設 `rgba(0,0,0,.18)`;LCD 上一閃就
沒了,e-ink 的殘影會讓它留在畫面上,於是**只有使用者點過的**按鈕看起來莫名有灰底,
沒點過的連結完全正常 —— 很容易誤判成某幾個元件的樣式壞了)。兩者都在
`html.eink` / `.eink ::selection` 直接宣告。

**必須改渲染、CSS 構不到的只有三處**:`Avatar`(react-animals 是 inline style
的彩色 SVG → 改渲染首字 + 四種框線)、`ActivityHeatmap`(顏色 bake 進 SVG,五階
明度改成 `<pattern>` 網底密度;空白格靠 `:not([fill])` 認 —— 有活動的格子才會被
d3 寫上 `fill` attribute)、以及 `.tiptap` 底下那些沒有 class 的元素
(`<pre>`/`<mark>`/`<th>`)。螢光筆與 AI 自動挖空在灰階下必撞,改用線型區分:
**手動螢光 = 實線/實心**(使用者自己畫的),**AI 挖空 = 虛線**(機器猜的)。

**使用者上傳的醫學圖片與 PDF 內容刻意豁免,不二值化。** 血液抹片、免疫染色、
流式散點圖的顏色本身就是要學的診斷資訊;CSS 的 `contrast()` 是硬閾值不是
dithering,結果比原圖更難讀;真 e-ink 硬體本來就會做抖動處理。

驗證在 `frontend/e2e/eink.test.mjs`:走訪路由,斷言每個看得見的元素的每個顏色
屬性**不是全透明,就是 r===g===b 且 ∈ {0,255} 且 alpha===1**。`alpha===1` 是
關鍵 —— 半透明黑疊在白底上就是灰。**它有盲區,而且盲區是實際踩到的**:
`getComputedStyle(el)` 讀不到偽元素,所以搜尋框的淺褐色 placeholder 掃描全綠、
只有把畫面截圖出來看才發現(現在偽元素也掃了,但 hover/focus/拖曳中仍掃不到 ——
那些靠中和層 specificity 高於 `hover:` 來保證,不靠測試)。
**掃描只掃得到「畫在畫面上」的元素**,而 `/q/:id` 在手機是分頁的(見下面的
換題/版面那節):詳解那一欄在題目分頁下是 `display:none`,整欄會被
`getClientRects()` 跳過。防劇透的那團灰能活到使用者手上,正是因為沒有任何一條
路由走到詳解分頁 —— 現在多了一條專門走過去的。**加新分頁時要問的是「這一頁有
沒有哪一塊從來沒被掃過」**,不是「路由列表有沒有這條路徑」。
另外**題目頁的選項是 `<li>` 不是 `<button>`**:用 role 找會什麼都點不到而測試
照樣全綠,所以那條路徑有 `expectAfter` 的正面斷言擋著。改動這支測試時,先確認
它在停用中和層時會紅。

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

### 導覽階梯:項目要**晚**一個斷點才出現,以及那顆強制手機版面的 FAB

頂端導覽用「尾端項目摺進 `更多` 下拉」的作法,但舊版每一階都比塞得下的寬度**早**
一個斷點放出來,於是 **斷點本身那一刻最擠**:量出來 4 項 + 更多 需要 ~704px、
6 項 ~816px、8 項 ~936px,而它們分別在 640 / 768 / 1024 就冒出來 —— 640 與 768
必定溢出整頁,320 則是連品牌 + 右側工具列都塞不下(回報 #94)。常用的
390 / 414 / 1440 剛好全都沒事,所以它活了很久。

- **底部導覽列因此撐到 `md`(不是 `sm`)。** 640–767 這段上面那條放不下,由它接手;
  `App.tsx` 的 `md:hidden` 與 `styles.css` 的 `--bottom-nav-h` 是同一件事的兩半,
  **改一邊沒改另一邊**,`<main>` 的下方留白就會跟導覽列對不上而蓋住頁尾。
- **`更多` 下拉裡的 `xx:hidden` 必須跟列上 `NavItem` 的 `xx:block` 對齊**,否則
  不是同時出現兩次,就是整條到不了 —— 兩種都無聲。**只存在於下拉裡的項目**
  (影片)要在下拉收起來的那一階補一顆到列上,不然最寬的畫面反而走不到。
- **`OnlineUsers` 移到 `lg`**:它的寬度隨線上人數變動,是整條 header 唯一寬度不
  固定的東西。擺在窄的那幾階,溢出與否就取決於當下有幾個人在線 —— 用斷點事先算
  不準的東西,不要放在算得剛剛好的地方。
- **品牌是唯一可讓步的元素**(`min-w-0 truncate`,其餘 `shrink-0`)。這是結構性
  保證,不是階梯的替代品:品牌名是 `config.toml` 來的,fork 換個長名字階梯就不準了。
- 守門在 `frontend/e2e/overflow.test.mjs`,寬度**繞著斷點兩側取樣**
  (639/640、767/768、1023/1024、1279/1280)。**`users_online.json` fixture 要保持
  非空** —— 空的時候 700/767/820/1024 四個寬度全是綠的,而那正是漏掉的原因。
  只認頁面層級的捲動;內部自己捲的容器(寬表格、程式碼區塊)是刻意設計。

**「強制手機版面」只有改 viewport meta 這一條路**(`lib/viewportMode.ts` +
`ViewportModeFab`)。版面幾乎都寫在 `md:`/`lg:` utility 裡,而 media query 問的是
視窗寬度、不是任何 React state —— 要嘛把三千多處改成 container query,要嘛讓瀏覽器
相信視窗就是那麼窄。寬度 560 是同時小於 `sm`(底部導覽列才會回來)與 `md`(才拿得到
手機版面)。**桌機瀏覽器完全忽略 viewport meta**,所以 FAB 只在 `(pointer: coarse)`
出現:一顆在 Mac 上按了沒反應的按鈕比沒有更糟。**而且這個效果在測試環境驗不到** ——
Playwright 兩個引擎都用 `setDeviceMetricsOverride` 把版面視窗釘死,meta 寫對了
`innerWidth` 也不會變,所以測試只鎖「寫進去的內容對不對」。元件因此在點擊後 300ms
自己量一次寬度,沒變就重新載入(從 HTML 解析進來的 meta 是所有引擎都認的)—— 常見
情況不會重整,編輯中的草稿不受影響。

## Testing & Debugging

- Local D1 lives at `.wrangler/state/v3/d1/`
- Wipe local DB: `rm -rf .wrangler/state`
- View D1 contents: `wrangler d1 execute qa-db --local --command "SELECT * FROM questions LIMIT 5"`
- Wrangler tail prod logs: `wrangler tail`
- Pages logs: dashboard → Pages → project → Functions tab

### Frontend changes must be verified on WebKit, not just Chromium

`pnpm test` covers pure functions only. For anything touching React lifecycle,
TipTap, or rendering, run:

```bash
pnpm test:webkit        # builds frontend, then WebKit + iPhone 13 smoke test
```

This exists because of a real outage: until 2026-07-29 **every iOS user got a
blank question page**, while 364 unit tests passed and Chromium was fine. The
cause was a timing race that WebKit hits deterministically and Chromium never
does — `useEditor` hands back an already-destroyed Editor, writing to it throws
during React's commit phase, and React 18 responds by unmounting the whole tree.
iOS forces every browser onto WebKit, so "works in Chrome" is not evidence here.

The test (`frontend/e2e/`) asserts only two things per route — renders something,
no uncaught `pageerror`. It runs against the **production build** (the dev
server's StrictMode double-mount produces different, misleading symptoms) and
serves canned API fixtures rather than a live Worker, so it needs no D1 or
Cloudflare credentials.

It also gates the Pages deploy workflow with `E2E_REQUIRE=1`, which turns "browser
not installed" into a failure instead of a silent skip. Adding a route means
adding a fixture: hit the real endpoint under `wrangler dev` and save the response
to `frontend/e2e/fixtures/<path-with-slashes-as-underscores>.json`. Endpoints with
no fixture get `{}` and are listed at the end of the run.

## Cost Awareness

This is designed to fit in **free tier indefinitely** for 20 users. If a feature would push past free tier, call it out explicitly. Don't silently add paid services. Note: SQLite-backed Durable Objects (`new_sqlite_classes`) ARE available on the free plan (the chat lobby uses one) — only KV-backed DO storage requires Workers Paid.

## Owner Notes

- Original spec from user: 1000 題, 10 年, 共筆詳解, 留言討論, @mention, 全真模擬, RWD, all Cloudflare
- AI features are optional add-ons, not core
- Future migration path to真共編 is reserved but not implemented

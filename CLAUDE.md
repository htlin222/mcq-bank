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
  to a Pages _Preview_, not production.** `wrangler pages deploy` derives
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

### 題幹的否定詞: 詞表的價值來自稀有

`lib/stemHighlight.ts` 把題幹裡的 `incorrect` / `wrong` / `except` / `false` /
`not true` / `錯誤` / `不正確` / `為非` / `何者非` 標紅加粗(#149),用在複習模式與
模擬考的題幹。回報的原話是「比較好看」,但真正的價值是**不要整題讀完才發現問的是
「何者錯誤」** —— 這個題庫最常見的誤答就是這種。

詞表是逐個在題庫裡數過才定的(1100 題:wrong 245 · 錯誤 69 · incorrect 42 ·
except 38 · 為非 31 · 不正確 29 · false 5),並抽樣看過 `wrong` 的上下文確認沒有
誤命中。

- **`is not` 有收(59 題,抽樣全是 is NOT likely / necessary / indicated /
  correct 這種問句骨架);單獨的 `not` 沒有。** 差別在「is not」幾乎只出現在問句
  骨架上,而「not associated」是選項的日常用語。同理單獨的「非」不收 ——
  非何杰金氏淋巴瘤、非典型…幾乎每頁都有。**這一層的價值來自稀有,詞表一長就
  沒有作用了**,所以測試除了「有標到」也守著「不該標的沒被標到」。
- **判斷「該不該收一個詞」的樣板是 `no evidence` / `without evidence`。** 兩者在
  題庫裡各一題,字面同樣像否定,但 `112-049` 的「Which kind of agent has **no
  evidence** of clinical benefit?」在**問句骨架**上,而 `112-031` 的「ADAMTS13
  activity 68%, **without evidence** for an inhibitor」在**病歷敘述**裡 ——
  標到後者會讓人以為那句是題目的陷阱所在。收前者、不收後者。
  **看它出現在哪裡,不是看它像不像否定。**
- **詞表按長度排序才組成正則。** `|` 是「取第一個 match 得上的分支」不是取最長 ——
  不排的話「is not true」會在 `is not` 那一支停下來,標成 `is not` 加上沒標的
  `true`,看起來像標錯位置。排序做在組正則的地方,不是要求詞表手動維護順序:
  那種順序沒有人看得出來為什麼,加一個詞就可能靜靜破壞另一個。
- **拉丁字卡字界,中日韓不卡**(沒有字界)。`wrongly`、`exception` 不算。
- **回傳片段而不是 HTML 字串。** 題幹是匯入的資料,而這一層只是排版,沒有理由
  讓它有機會注入標記 —— 同「HTML in DB」那條。
- **`g` 旗標的 `lastIndex` 要重設。** 共用同一個 RegExp 實例時,第二次呼叫會從上次
  結束的位置開始找,於是同一段文字第二次就標不到 —— 有一條測試專門連呼叫三次。
- **顏色用主色 `accent`(#a8442a),不是另外一個 rose。** 站上每一處強調都是它,
  多一個紅只會讓畫面多一種說法。深色模式走 `accent-light`(#cb6845)—— #a8442a
  在 ink-900 上對比不足。
- **e-ink 底下顏色會被中和成黑色**,所以語意不能只靠顏色:粗體本來就活得下來,
  再補 `eink:underline`。同該節的「顏色沒了之後,語意要換一個維度重講」。
- e2e 的題幹由 `ctx.route` 注入,**不改 fixture** —— fixture 的題幹與筆記是好幾支
  測試共用的素材(gamepad 那條實際踩過)。

### 筆記工具列與分頁列: 兩種形態,一份定義

`/q/:id` 有兩處「窄螢幕才收起來」,判準都是 `hooks/useNarrow.ts`(<sm):

- **筆記工具**(自動挖空 / 防劇透 / 編輯)—— 窄螢幕收進 `<CircleEllipsis /> 更多`,
  寬螢幕直接畫成按鈕。`components/NoteToolsMenu.tsx` 匯出兩個渲染器,吃**同一份**
  `NoteTool[]` —— 各寫一次的話,新加的按鈕遲早只出現在其中一種寬度下,而那在另一種
  寬度看不見。**全螢幕不在這組裡**:它是唯一每天都會按的,而且進了選單就得先關掉
  選單才看得到放大後的樣子。
- **分頁列**(題目/詳解/個人筆記/討論串/相似題目/影片)—— 尾端摺進
  `<EllipsisVertical />`,同 header 的階梯。六個在 390px 上必定折行,而那條 strip
  是 sticky 的:折行等於每次換題都少一行可讀高度。

⚠️ **目前這一頁一定要留在列上,即使它屬於被摺起來的那幾個。** 少了這條,從選單挑
「影片」之後,六個分頁沒有一個是亮的 —— 看不出自己在哪。

**下拉的預覽字數是 10 字(`NOTE_TITLE_NARROW`),不是 `NOTE_TITLE_MAX` 的比例。**
兩者回答不同問題:一個是「標題最長多少」,一個是「一眼認得出是哪一則要幾個字」。
綁成比例的話,調其中一個會莫名其妙牽動另一個。

三個下拉(筆記切換器、筆記工具、分頁溢出)的關閉邏輯共用 `hooks/useDismiss.ts` ——
抽出來不是為了行數,是**行為要一致**:少一邊的 Esc、或某一個用 `click` 而不是
`mousedown`,使用者只會覺得「有些選單關得掉、有些關不掉」,而那很難回報得清楚。

⚠️ **「會被擠出去的那一列」要的是 `min-w-0`,不是 `max-w-full` —— 兩者管的不是
同一件事。** 筆記切換器是 `<往左> <選單> <往右>`,中間那顆原本寫 `max-w-full`,
於是標題一長就把「下一則筆記」整顆擠到容器外(實測溢出 46px,390 / 768 / 1024
都中)。原因是 flex item 的 `min-width` 預設是 `auto`(= 內容寬),所以它**根本
不肯縮**;而 `max-w-full` 只是把上界訂在「整個容器」,而容器裡還有左右兩顆跳頁鈕。
**上界不等於收縮** —— 要縮得下去只有 `min-w-0`,截字再交給裡面的 `truncate`。
同一個形狀在別處出現時判準是「這顆的右邊還有沒有東西」:聊天的回覆片段
(`chat/MessageItem.tsx`)是氣泡裡的獨立區塊,右邊沒有兄弟,`max-w-full` 就是對的。

守門在 `frontend/e2e/note-switcher-overflow.test.mjs`,三個寬度取樣,而且**先斷言
標題真的被截斷了**(`scrollWidth > clientWidth`)再量溢出 —— 少了那道防線,標題不夠
長的寬度(實測 640)本來就不會溢出,那條斷言會退化成恆真的綠燈。

驗證在 `frontend/e2e/tab-overflow.test.mjs`,**繞著斷點兩側取樣**(390 / 640)——
只測 390 的話,把條件寫成「永遠收起來」也會全綠。量折行用**倍率**不用固定餘裕:
實測單行 48.4px 而按鈕 42px,寫死「+6」差一點就假紅(而手動量測時的四捨五入讓它
看起來剛好通過)。

⚠️ **e2e fixture 的筆記標題是好幾支測試共用的素材。** `questions_113-050.json` 的
第二則標題被拉長成 40 字是為了驗預覽截斷,而 `gamepad.test.mjs` 原本寫死那個字串
—— 一動就紅在一個跟手把完全無關的地方。現在它從 fixture 推出期望值。

### 個人筆記的拖曳排序: 為什麼多開一個欄位,以及門檻是鄰居的中線

`personal_notes.sort_order`(migration 0041)+ `PUT /api/questions/:id/notes/order`。

**兩個看起來可以重用的欄位都不能用:**

- `slot` 是 PK 的一部分,而 `highlights.store_key`(`anno:note:<qid>:<slot>`)、
  `note_cloze`、`note_terms`、`note_link_suggestions` 全都以它定位。拿它重排等於
  把畫記與挖空快取搬到別則筆記身上。
- `created_at` 改寫就是讓欄名說謊 —— 而且「依建立順序排」正是 0036 加那個欄位的
  理由,重排一次之後那個語意就沒了。同「自由筆記的 id 不塞進 `question_id`」那條。

**讀取端一定要排兩個鍵(`ORDER BY sort_order, slot`)。** 既有列都是 0,漏了第二個
鍵的話同分列的順序由 SQLite 自由決定,使用者會看到筆記每次重整都換位置 —— 而且
在只有一兩則筆記的帳號上完全看不出來。

**重排請求必須是現有 slot 的排列,少一個多一個都整批拒絕**(`resolveNoteOrder`)。
放行部分正確的請求會寫出一份「有些排過、有些沒有」的順序,而那在畫面上只是
「排錯了」,使用者不會知道是請求壞掉。寫入走 `DB.batch` —— 分開送的話中途失敗會
留下一半新一半舊。

**落點的門檻是鄰居的中線,不是自己的。** 這條是 e2e 抓到的:握把在自己那一列的
正中央,把自己的中線也算進去時,往下移 3px 就越過了 —— 手指還沒離開原本那一列,
順序就跳一次。排除自己之後要真的蓋過下一項的一半才換位。純函式在
`frontend/src/lib/reorder.ts`,邊界(夾到頭尾、剛好壓在線上歸哪一邊)都在那支的
測試裡 —— 在瀏覽器裡模擬指標事件會隨時序飄。

- **用 pointer events,不用 HTML5 drag-and-drop** —— 後者在觸控裝置上根本不觸發,
  而這個下拉最擠的時候正是手機。握把要 `touch-action: none`,否則手指往下滑會被
  判定成捲動清單,拖曳收不到 move。`setPointerCapture` 也是必要的:少了它,指標
  移出那一列就收不到事件,拖到一半會卡住。
- **拖曳中的順序存在 `NoteSwitcher` 自己的 state**,放開才打請求。呼叫端只收到
  最後的結果 —— 中途每一次換位都送一趟的話,一次拖曳會打十幾個請求。
- **放回原位不送請求**(`sameOrder`)。
- e2e 驗的是「拖曳中畫面有沒有跟著走」+「送出去的 slots 對不對」,**不驗放開後的
  清單** —— `reorderNotes` 結尾會 reload,而 fixture 是靜態的,拖完一定會彈回原
  順序。驗那個等於驗 fixture。

### 筆記的左右滑動: 判準只有角度,因為那張卡不能關掉捲動

手機在個人筆記卡上左右滑動換上一則 / 下一則。方向判準是純函式
(`frontend/src/lib/swipeNav.ts`),接線是 `hooks/useSwipeNav.ts`,兩個入口
(觸控滑動、手把十字鍵左右)共用 `Question.tsx` 的 `goNote()`。

**用 Touch events,不用 Pointer events。** 瀏覽器一旦認定手勢是捲動就會送出
`pointercancel`,而在一個只能垂直捲的頁面上,水平拖曳常常在我們看清方向之前就被
收走 —— 症狀是「滑動時靈時不靈」,而且在桌機上完全重現不出來。touch 那組不會被
這樣收掉。這跟 `NoteSwitcher` 的拖曳握把用 pointer 不衝突:那裡的握把可以掛
`touch-action: none` 把捲動整個關掉,**筆記卡不行 —— 它就是要捲的**。同理
`routes/Play.tsx` 的棋盤(不捲)可以直接關,這裡只能靠角度分。

四道護欄,每一道都擋掉一種會讓人以為「壞了」的誤觸:

| 護欄                    | 擋的是             | 漏掉的症狀                                  |
| ----------------------- | ------------------ | ------------------------------------------- |
| `SWIPE_MIN_X` 60px      | 讀到一半手指抖一下 | 筆記莫名其妙換掉,而使用者不知道自己做了什麼 |
| `SWIPE_RATIO` 1.5(≈34°) | 捲動               | 往下捲一路換筆記                            |
| `SWIPE_EDGE` 24px       | iOS 邊緣返回手勢   | 返回「壞了」—— 比沒有滑動換頁糟得多         |
| `SWIPE_MAX_MS` 700ms    | 選字 / 畫螢光      | 畫記畫到一半整則筆記被換走                  |

選字另外有第二層:`touchend` 當下 selection 沒收合就整個不處理。副作用是**選字
工具列開著時滑不動**,那是要的 —— 那時使用者的意圖在那段文字上。

**`goNote()` 一定要捲回頂端,而且捲的容器有三種。** 全螢幕時是卡片自己
(`fixed inset-0`)、雙欄模式是右欄、其餘是頁面。不捲的症狀是「好像沒換」:
換過去停在上一則的捲動位置,短的那則看到的是頁尾或空白。手把的十字鍵左右因此
一起改走 `goNote` —— 同一個動作分兩處寫,新加的行為遲早只在其中一邊成立。

**e2e 的手勢是合成的,而且只有一條路走得通。** `page.touchscreen` 只有 `tap()`,
`page.mouse` 發的是滑鼠事件(這個功能刻意不吃),WebKit 的 `new Touch()` 是
Illegal constructor —— 可用的是舊 API `document.createTouch` /
`createTouchList` + `new TouchEvent`。時長不能用參數假造:`timeStamp` 由引擎給,
所以 `SWIPE_MAX_MS` 那條要真的等。

⚠️ **「不該換筆記」那三條斷言在功能沒接上時全部成立**,所以同一支測試的結尾有一條
對照組(同樣位移、快滑,要換得動)。停用 `enabled` 重建驗證過:兩支都紅,而且第二支
正是倒在對照組那一行。同「gamepad 那節要驗正面效果」與 `users_online.json` 空
fixture 那兩個坑。

### 講義書籤: 兩種頁碼慣例並存,所以轉換只准發生在一個地方

閱讀器左側 rail 的第二個分頁、工具列那顆 toggle,以及 `/lectures?tab=bookmark`
的卡片格線(migration `0042`)。一列 = 「某人在某份講義的某一頁插了旗子」,私有,
同 `lecture_notes` / `lecture_annotations` 的 per-user 模型。

**頁碼存 1-based。** 這個 repo 裡兩種慣例已經並存 —— `lecture_notes.page` 是
1-based(`LecturePanel` 的 `pdfPage = currentPage + 1`),`lecture_annotations.page`
卻是 0-based(清單顯示寫的是 `p.{a.page + 1}`)。書籤卡片的預覽要 join
`lecture_notes`,所以跟 join 對象一致,0/1 的轉換就只發生在 `LectureReader` 的
`currentPdfPage` 那一行。**多一處轉換就多一個會 off-by-one 的地方**,而 off-by-one
在這裡的症狀是「書籤跳到隔壁頁」—— 看起來像 PDF 捲動不準,不像資料錯。e2e 因此
斷言的是**具體頁碼**(`{method:'POST', page:1}`),不是「有送出請求」。

- **`UNIQUE(user_email, slug, page)` 是承重的。** 工具列那顆是 toggle,「同一頁
  只有一筆」正是它的前提;少了唯一鍵,連點兩下會寫出兩列一模一樣的資料,而畫面上
  只是「書籤清單多了一行重複的」,看不出是寫入壞掉。有了它,`INSERT OR IGNORE`
  就讓「先查再寫」那個 race 整個消失。
- **`/bookmarks` 必須註冊在 `/:slug` 之前**(Hono 依註冊順序比對)。放反的症狀是
  前端拿到「找不到這份講義」的 404 —— 完全不會指向路由順序。
- **筆記預覽在 SQL 裡就從 TipTap JSON 走出來**,沿用 migration 0016 的同一個慣用法
  (`json_tree` → `key='text' AND type='text'`),不把整份 `content_json` 送到前端
  再走一次:一頁筆記可以有幾十 KB,而卡片只用得到兩行。**那一頁沒有筆記時回的是
  `NULL` 不是 `''`**(外層純量子查詢沒有列可回),所以 shape 那一層要收掉。
- **排序做到全序**(`lib/bookmarkSort.ts`)。`created_at` 是毫秒,在 rail 上一路往下
  標會撞;`sort_order` 更是整份講義共用同一個值。同分交給 `sort` 自由決定的話,
  使用者看到的是「每次重整卡片就換位置」,而且在只有兩三個書籤的帳號上完全看不
  出來 —— 同「個人筆記拖曳排序」那節的 `ORDER BY sort_order, slot`。
- **rail 上非當前分頁一律 unmount。** `ThumbnailsPane` 是虛擬化的(位置由它自己
  量出來),用 `hidden` 藏起來會讓它在高度 0 的容器裡重算 —— 切回來看到的是一堆
  疊在一起的縮圖。
- **兩個分頁共用同一條 rail 與同一顆開關**,不是各開一條:兩條 rail 同時展開會把
  PDF 可視寬度吃掉一半,而在這個閱讀器裡寬度就是可讀性本身。
- **`/api/lectures/*/bookmarks` 不進 `sw-guards.ts` 的 `CACHEABLE_API`。** 現有的
  `/^\/api\/lectures(\?|$)/` 只認完全相同的路徑,所以它們「剛好」不在允許清單裡
  —— 那是巧合不是決定,有測試釘著。被快取住的症狀是「加了書籤、重整,不見了」。
- 教科書(`kind='textbook'`)不給加:rail 的分頁列整條隱藏(只剩一個項目的分頁列
  不是分頁列,是一行贅字),`b` 鍵落回 `default` 而不是靜靜吃掉按鍵,伺服器也擋。

⚠️ **加分頁會弄紅 `lectures-tabs.test.mjs`** —— 那支釘死「四顆分頁都在」當空掃
防線。那是它該有的行為,改數字時要連標題那條(`new Set(titles).size`)一起改。

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

⚠️ **而且要補**兩個**地方 —— 主 checkout 之外還有 CI 的 `WRANGLER_TOML`
secret。** 2026-08-10 真的漏了後者:主 checkout 補齊了 v2/v3、本機 `wrangler
deploy` 一路正常,但 CI 那份仍停在只有 `tag = "v1"`,於是自動部署掛在

```
Cannot apply new-sqlite-class migration to class 'ChatRoom'
that is already depended on by existing Durable Objects [code: 10074]
```

—— 錯誤訊息指著 `ChatRoom`(v1),而真正的問題是 v2/v3 不在那份 toml 裡,
所以 wrangler 從頭重放。**這個症狀在本機重現不出來**,因為本機那份是對的。
同步方式:`gh secret set WRANGLER_TOML < wrangler.toml`。`CONFIG_TOML` 同理。

### 作答歷史: `attempts` is the source of truth

`attempts` (migration `0023`) is an append-only event log — one row per
answer, with `source` (`review`/`exam`/`drill`/`anki`), optional
`session_id`, and client-measured `elapsed_ms` (server-clamped by
`clampElapsedMs` in `worker/lib/attempts.ts`).

- **`review_progress` is a derived cache.** `times_seen / times_correct /
last_*` are all recomputable from `attempts`. It's still dual-written
  (and always will be) because it _also_ carries `bookmarked` /
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

### 答題狀態分析: 把 `attempts` 原樣交出去

個人頁的「答題狀態分析」(`/api/attempt-log`,
`frontend/src/components/profile/AttemptLogCard.tsx`)下載一份逐次作答的 CSV
長表,條件是年份 / 只要答錯 / 作答區間,預設全部。站內其他統計都是「幫你看完
再給結論」,這張卡刻意相反 —— 不歸納,只把原始列倒出來。

三個不明顯的地方:

- **只取 `chosen IS NOT NULL AND is_correct IS NOT NULL`。** 前者是「有作答」
  (交卷補的空題會寫一列 `chosen = NULL`);後者排掉模擬考交卷前尚未判定的列。
  留著會讓「是否答對」欄出現空白,任何樞紐分析的正確率都會被那幾列拖歪。
- **信心是靠 timestamp 接的,不是靠 id。** `confidence_events` 沒有
  `attempt_id`,但 `review.ts` 的 `/answer` 用同一個 `now` 同時寫兩張表,所以
  `(user_email, question_id, at = created_at)` 是精確對應。要是哪天把兩者的
  時間戳拆開寫,這個 join 會靜默變成全空白而不是報錯。
- **`/api/attempt-log/*` 不能進 `sw-guards.ts` 的 `CACHEABLE_API`** —— meta
  反映的是「你剛剛答了幾題」,快取住等於年份選單永遠少一年。

CSV 帶 BOM(否則 Excel 會用系統字碼頁開成亂碼),欄位走 `csvCell()` 以中和
`=` 開頭的公式注入。純函式與測試在 `worker/lib/attempt-log.ts`。

### PWA: offline _reading_ only, and the Access trap

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

**但那只修掉一半,而剩下那一半的覆蓋位置跟直覺相反。** 回報再度出現「來回切換
還是會遺失」時,直覺是去找「回到這題時重抓,把它洗掉了」—— 錯的,**回來時根本
不會重抓**(TTL 內 peek 就命中,一次網路都不發)。真正動手的是**離開的時候**:
`Question.tsx` 在鄰居題上閒置時會預抓它自己的鄰居,而剛作答那一題正好是其中
之一。預抓回來的 payload 被無條件 `set()` 進快取,蓋掉 `withAnswer()` 寫入的
作答紀錄;等使用者切回來,peek 拿到的已經是被蓋過的版本。

所以**「回到這題時有沒有重抓」這個角度永遠看不到它** —— 我照這個角度寫的 e2e
測試量出來是「0 次重抓」,於是給了一個什麼都沒驗到的綠燈。找到它的方法是把
作答→離開→回來每一階段的 payload 請求數與畫面狀態逐段印出來,`④ 到鄰居題`
那一行 `+1` 就是兇手。

修法是 `preserveLocalAnswer()`,掛在 **`questionCache` 的 fetcher** 上 —— 那是
背景重抓、`reload({force})`、閒置預抓三條路徑的唯一交會點,掛在呼叫端會漏掉
預抓那條(而它正是實際出事的那條)。判準收得很窄:只有「對方沒有 `last_chosen`
而本地有」才保留,伺服器有紀錄時一律以伺服器為準。使用者主動清除走
`withProgressCleared`,本地也會是 null,不會把它救回來;「在另一台裝置清除」
會被擋住,但重新整理就拿得到真相(整頁重載時快取是空的)。

驗證刻意**不**放在 e2e:那條路徑依賴 `requestIdleCallback` 的時序,測試環境下
預抓發不發得出去、回應趕不趕得回來,會隨 `apiDelayMs`、引擎、作答前有沒有停頓
而變 —— 調了四輪都無法穩定紅,而不穩定的測試會用假綠騙人(這一題上已經騙過
兩次)。改成 11 條純函式測試涵蓋所有邊界,整合層的重現用一次性腳本做掉。

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

### 分頁的載入卡頓: 兩個成因,而 KV 一個都救不到

回報是「每天的評論 / 個人筆記 / 詳解,載入總覺得卡頓一下」,問的是「有沒有更好的
KV、快取、預載入」。量完之後成因有兩個,**而它們一個是網路、一個是主執行緒,
解法完全不同**:

| 量到的(桌機 Chromium 未節流,手機約三到五倍)       | 改之前         | 改之後 |
| ------------------------------------------------- | -------------- | ------ |
| 進 `/q/:id`(**還沒點討論串**)就建好的 ProseMirror | 14 個          | 1 個   |
| 同上,留言端點被打的次數                           | 1 次           | 0 次   |
| 同一題來回切三圈,留言端點累計                     | 4 次           | 1 次   |
| 桌機雙欄下點開「討論串」                          | 編輯器 14 → 26 | 不變   |
| 第一次點開「討論串」(6x CPU 節流)                 | 66.7ms         | 7ms    |
| 一次切分頁的 render + commit(6x 節流)             | 7.5ms          | 4.9ms  |

⚠️ **這一節第一版寫著「切分頁要 20–25ms,那是 `Question.tsx` 自己重繪的成本,
想再往下壓要動那個元件」—— 那是錯的,而錯在量測方法上。** 更正連同方法一起留在
這裡,因為這個 repo 之後還會量很多次 UI 延遲:

- **不要用 `requestAnimationFrame` 當「做完了」的訊號。** 一個 rAF 就是一次幀邊界
  (60Hz ≈ 16.7ms),兩個就是 33ms。那 20–25ms 幾乎全是**等下一幀**,不是工作。
  用 CDP profiler 對著同一段操作取樣,結果是 **91.2% idle**。
- **也不要在 `click()` 之後同步讀 DOM 就以為量到了。** React 18 的 sync work 排在
  **microtask**(`ensureRootIsScheduled` → `scheduleMicrotask`),所以
  `btn.click()` 回來的當下畫面**還沒換**。照那樣量會得到 0.1ms 這種假數字 ——
  當時差點據此宣布「完全沒有成本」。判準是同步讀一個會變的東西(例如看得見的
  編輯器數)有沒有真的變。
- 正確的量法:`click()` → `await` 兩層 `queueMicrotask` → 讀時間,並用
  `Emulation.setCPUThrottlingRate` 節流 6x 模擬中階手機。這樣量到的 render +
  commit 是 **0.7ms(1x)/ 5.1ms(6x)** —— 遠低於一幀,`Question.tsx` 的重繪從來
  就不是瓶頸。

**真正貴的是 TipTap 的 `EditorView` 建構,一個約 30–50ms(6x 節流)。** 所以會不會
頓,取決於**這個動作有沒有順手建一個編輯器**,而不是分頁大不大。

**KV 是錯的工具,而且理由不是「不夠快」。** `/api/questions/:id` 早就把九個查詢
併成一趟 `Promise.all`,D1 那一趟不是瓶頸;KV 是最終一致、寫入全球傳播最長 60
秒,而詳解是共筆、筆記是本人三秒前存的 —— 「存完重整看到舊的」比慢更糟,同上面
那節不把 `/api/questions/:id` 改成 SWR 的理由。

**四個踩過的坑:**

- **CSS 隱藏不是不渲染。** 頁尾那份給「雙欄模式的窄版面」用的 `CommentThread`,
  class 是 `tabsMode ? "hidden" : "md:hidden"`。#96 之後 `<md` 一律走 tabs,所以
  `!tabsMode` 就等於 `≥md` —— **兩種情況都看不見**。它卻照樣掛載、照樣抓一次留言、
  照樣替每一則留言建一個 TipTap。也就是說每個人開任何一題都在背景抓討論串,而使用
  者連分頁都還沒點。已移除;上面那條 strip 是現在唯一的入口。
- **唯讀內容原本用的是真的編輯器。** `useEditor` 在 tiptap 2.x 的
  `immediatelyRender` 預設是 true,所以每一個唯讀區塊都在 **render phase 同步**
  建構一次 EditorView(建 schema、實例化 15 個 extension、掛 plugin)。現在分成
  兩條路:需要畫記 / 自動挖空 / 防劇透的(詳解、個人筆記)仍然走
  `AnnotatableContent`,其餘(留言、挑戰理由、Anki 卡)走
  `lib/staticDoc.ts` 的 JSON→React 渲染器。
  **刻意不用 `generateHTML()` + `dangerouslySetInnerHTML`** —— 那會把文件裡的屬性
  原樣序列化成標記,而 `content_json` 是使用者可寫的欄位。React 元素沒有這個問題。
  渲染器寫成 `.ts` + `createElement` 而不是 `.tsx`,是為了進得了 `pnpm test`
  (node 的型別剝離不處理 JSX),而它的兩個要害 —— 未知節點會不會讓內容整段消失、
  `href` 有沒有擋住 `javascript:` —— 正是最需要單元測試釘住的。
- **「看過就留著」買到的是狀態,不是時間。** 分頁原本切走就整棵卸載,於是**筆記
  展開到一半的手風琴會全部收合回去** —— 瞄一眼詳解再切回來,讀到哪裡就沒了。
  `components/KeepAlive.tsx` 第一次符合條件才掛載,之後改用 `hidden`。
  **不要拿它當效能改善來賣** —— 切分頁的 render + commit 本來就只有幾毫秒。
- **而且它必須凍住隱形的子樹。** 天真的實作會讓每次 `setTab` 的重繪連三個 pane
  一起跑 —— 留著的 pane 愈多、每次切換愈貴。作法是收著上一次的 element,`active`
  為 false 時原樣交回去:React 看到 `prev === next` 就**整棵跳過**(element
  identity 的短路,不是 memo)。隱形時看到的是舊 props,而那正好是要的 —— 它看不
  見,重新亮起來時交出去的就是新的那一份。實測(6x 節流)切到詳解 8.5 → 4.4ms、
  切到討論串 12.6 → 10ms。
- **代價是隱形分頁的控制項還在 DOM 裡。**
  使用者碰不到(`hidden` 同時移出 a11y tree 與 tab order),但
  `document.querySelector('article')`
  與 `page.locator('button', {hasText:'編輯'}).first()` 會拿到**隱形的那一個**。
  三支 e2e 因此紅了,而症狀(click 逾時、`getBoundingClientRect` 讀到 undefined)
  完全不指向原因。**這一頁上的選擇器一律要限定看得見的元素** ——
  `getClientRects().length` / `button:visible`,repo 裡本來就有這個慣用法
  (`countDelete`)。

**`seedEmptyComments()` 那道閘是承重的。** 大多數題目底下一則留言都沒有,而題目
payload 的 `comment_count` 已經回答了 —— 零則就直接把空陣列寫進快取,點開分頁是
同步命中、一次網路都不發。但 **`comment_count` 來自快取的 payload**:使用者剛發完
言,它仍然寫著 0。少了 `locallyMutated` 這道閘,發完言切走再切回來會把自己剛寫的
那則蓋成空陣列 —— 無聲,而且只有換分頁才看得到。

**刻意不預抓鄰居題的留言。** 那會把「換題順一點」換成每換一題多一趟請求,而使用者
多半根本不會打開討論串。本題的留言排在 idle 預抓,不跟題目本身搶頻寬。

**Service Worker 那一層一行都沒動。** `/api/questions/*/comments` 本來就在
`sw-guards.ts` 的 `CACHEABLE_API` 裡,策略是 **NetworkFirst + 3 秒 timeout** ——
那是給離線閱讀用的,拿快取之前一定先等網路。它治不了這裡的病(每次切分頁還是要
等一趟 RTT),而且**不能改成 StaleWhileRevalidate**:那會讓「發完言重整看到自己
那則」讀到舊值,同上面 `/api/questions/:id` 那條。所以快取做在應用層 —— 失效時機
由 `lib/commentApi.ts` 自己掌握,SW 的 Access-redirect 防護不受影響。

**「討論串」的 66.7ms 其實一則留言都沒有 —— 全部是輸入框自己。**
`NewCommentBox` 是一個可編輯的 `RichEditor`,原本一掛載就同步建一次 EditorView。
而開討論串多半是為了**看**。現在收起來的時候畫一顆長得跟輸入框一模一樣的按鈕
(同樣的框線、圓角、內距、灰字提示),點下去才建真的編輯器並 `autofocus` ——
所以真的要留言的人沒有多按一下。

⚠️ **兩個例外一定要直接展開,而第二個是 TDD 才抓到的:**

- **手上有沒送出的草稿。** 草稿在 sessionStorage(`lib/drafts.ts`),看不見的草稿
  等於弄丟了,而使用者不會知道要去點一下才找得回來。判準用現成的 `isEmptyDoc()`,
  不是 `loadDraft() !== null` —— 後者會被「打了字又刪掉」留下的空文件騙到。
- **這是回覆框(`parentId` 有值)。** `NewCommentBox` 同時是最上面那個輸入框**和**
  每則留言底下的回覆框,而後者本來就是按下「回覆」才掛載的 —— 那一下已經表達過
  意圖,再要一次點擊只是把成本轉嫁給每一個要回覆的人。漏掉這條的症狀很輕微
  (「按了回覆好像沒反應」),所以容易活很久。編輯框走的是 `RichEditor`,不受影響。

守門在兩支,兩支都是**正面**斷言(先確認東西找得到、分頁真的打得開,再確認行為):

- `frontend/e2e/tab-cache.test.mjs` —— 快取與 KeepAlive。停用後重建過一次,三條都紅。
- `frontend/e2e/comment-composer.test.mjs` —— 延後掛載。「沒有編輯器」是負面斷言,
  **在整塊輸入區被拿掉時也會成立**,所以同一支測試裡先斷言「入口看得見」再斷言
  「點下去真的長出一個」,那個 0 才有話語權。

### 手把: 同一顆鍵在不同情境換意思,而且說明要跟著換

`/q/:id` 的手把綁定分散在兩層:`QuestionCard` 擁有選項游標與送出/複製/收藏,
`Question.tsx` 擁有需要頁面脈絡的那些(換題、換分頁、捲動)。在這之上再疊三種
**情境**,由 `Question.tsx` 判斷後接管:

| 情境   | 條件             | 十字鍵              | 面鍵                                |
| ------ | ---------------- | ------------------- | ----------------------------------- |
| 作答中 | `!cardRevealed`  | 選選項 / 調信心     | 送出 · 略過 · 複製 · 收藏           |
| 讀詳解 | `expKeysActive`  | 捲動                | 顯示詳解 · 自動挖空 · 防劇透 · 編輯 |
| 讀筆記 | `noteTabVisible` | 走訪標題 / 切換筆記 | 展開收合                            |

`SELECT`(開關說明)與 `START`、`L1/R1`、`L2/R2`、左搖桿三種情境共用,不換意思。

**`SELECT` 是保留給說明面板的,不要拿去綁功能。** 它綁在 `GamepadFab` 自己身上
(不在任何路由裡),開關那份說明 —— 這是唯一「不放下手把」也看得到說明的路。
少了它,想知道手把能做什麼就得先伸手去點螢幕,而那正是接手把的人在避免的事。
新路由要加綁定時,這一顆已經有主人了。

擴充時的四條規矩:

- **接管前先確認卡片不要那顆鍵,否則一次按鍵會做兩件事。** `FACE ▲ / ▶` 卡片
  無條件吃,所以要靠 `yieldFaceKeys` prop 讓它明確讓出;`FACE ▼ / ◀` 只在未揭曉
  時吃,揭曉後直接接管即可。**一定要等 `cardRevealed`** —— 搶在答題前接管 ▼,
  等於按下送出的同時把詳解也掀開。
- **每種情境一份 `GamepadHint[]`,不要 spread 共用那份再蓋。** 意思被換掉的鍵
  會留下兩行互相矛盾的說明。
- **每一行都要寫出失效條件**(「選了選項才有」「只有一則時無作用」「暫停中不能
  作答」「不連發,一下一題」)。按下去沒反應的鍵最傷:使用者分不出是自己按錯、
  手把沒連上、還是這一頁本來就沒這個功能,而前兩者會讓人開始懷疑整套手把操作。
  長按連發**只有十字鍵有**(`lib/gamepad.ts` 的 `REPEATABLE`),所以「可長按」
  這三個字不能順手加到 `L1/R1` 上 —— 押著肩鍵等它自己跑是等不到的。
- **情境條件寫的是 `mainTab`,那就要跟該情境的分頁同名。** `expKeysActive` 曾經
  寫成 `tab === "explanation" && (!tabsMode || mainTab === "note")`;分頁版底下
  `tab` 是跟著 `mainTab` 走的,所以那兩個條件互斥,整條**永遠 false**。症狀完全
  無聲:雙欄版靠 `!tabsMode` 短路過去所以正常,而分頁版(手機一律)讀詳解時那
  四顆面鍵一顆都不接管,`GAMEPAD_HINTS_EXPLANATION` 那份說明也就一次都沒出現過。
  **測試要繞著版型取樣**(`t` 切換),否則「桌機綠、手機死」可以活很久。
- **走訪清單優先問 DOM,不要另外維護狀態。** `NoteContent` 的每個手風琴各自持有
  `open`(刻意的:巢狀、彼此獨立),而收合的區段不渲染子節點 —— 所以
  `[data-note-heading]` 查到的按鈕,定義上就是使用者現在看得到的那些。焦點環用
  `:focus` 而非 `:focus-visible`:程式呼叫 `.focus()` 不一定被判定成
  focus-visible,那樣游標是隱形的。

**游標存在但看不見,等於功能沒接上。** 這條吃過一次三連環,而且三個症狀看起來
毫無關聯:回報是「DPAD ↑↓ 在 Xbox 360 上變成捲動」「A 鍵沒反應」「8BitDo 都
正常」。因果鏈只有一條:

```
D-pad 同時走軸(見下)→ 軸的 1400px/s 蓋過按鈕路徑的「跳一個標題」
   → 使用者讀到的是「畫面在捲」而不是「游標在動」
   → 不知道自己有游標,直接按 FACE ▼ → 游標仍是 -1 → 舊版直接 break → 毫無反應
```

修的是**兩端**:`axisScrollFrame` 讓按鈕獨佔那幾幀,以及 `FACE ▼` 在游標為 `-1`
時視為「從第一段開始」而不是「沒東西可展開」。中間那環是 `scrollIntoView` 的
`behavior: "smooth"` —— 走訪是離散動作,平滑位移把它畫成連續移動,而量出來每跳
一次 45–63px、跟 `GAMEPAD_SCROLL_STEP` 的 120px 同一量級,兩者在畫面上分不出來。

- **`gp.mapping === "standard"` 只保證按鈕索引對,不保證軸是乾淨的。**
  `nonStandardMapping()` 只檢查前者,而 Xbox 360 正是「回報 standard、索引也真的
  對、但 D-pad 被 driver 當 HAT switch **另外**寫進 axes」的情況 —— 不會觸發任何
  警告,症狀只表現成「某幾顆鍵怪怪的」。8BitDo 這類近年的原生 HID 手把對著
  standard mapping 校對過,所以完全正常;**「換一支手把就好了」不是排除軟體問題
  的證據**,它反而是這個病灶的典型指紋。
- **軸與按鈕搶同一幀時,讓按鈕贏,不要調高 deadzone。** 調 deadzone 是拿所有手把
  的小幅推動去換一支手把的相容性;讓按鈕獨佔的代價只有「按著 D-pad 同時推搖桿」
  這個沒人會做的組合。

驗證都在 `frontend/e2e/gamepad.test.mjs`(假 `navigator.getGamepads`)。**寫這裡
的測試要驗正面效果,不要驗「某個副作用沒發生」** —— 後者在功能根本沒接上時也會
通過。真的踩過:「FACE ▶ 之後收藏狀態不變」在功能停用時照樣綠,因為那顆鍵落回
卡片的收藏,而 fixture 的收藏 API 回空物件、狀態本來就不會動。**確認新測試會紅
的時候不要用 `pnpm build >/dev/null 2>&1`** —— 建置失敗被吃掉,測試會跑在舊
bundle 上,得到「停用了還是綠」的假結論。

**斷言「某個東西沒有動」的測試,一定要有一個對照組先證明它動得了。** 「D-pad 按
著時軸不該把頁面捲走」這條在修正還沒放進去時就是綠的 —— 救回來的是對照組
「左搖桿推到底會捲動」失敗,逼出兩層真相:`window.scrollY` 量不到(≥md 雙欄版型
下捲的是右欄自己的容器,不是頁面),而且**預設的 1280×900 底下那一題根本沒有東西
可捲**(`docScrollable = 0`,連 `window.scrollBy` 都不動)。少了對照組,那條斷言
恆真。`squash()` 先把視窗壓矮讓真實內容溢出,是這組測試能成立的前提。

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

| 層                                                   | Specificity       |
| ---------------------------------------------------- | ----------------- |
| 一般 utility / `hover:`                              | (0,1,0) / (0,2,0) |
| 中和層 `.eink.eink [class*="bg-"]`                   | (0,3,0)           |
| `.eink-invert` 的後代規則                            | (0,4,0)           |
| `eink:` variant(`tailwind.config.js` 的 `.eink×4 &`) | (0,5,0)           |

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

**第三個是 UA 的預設 focus ring,而且它的症狀跟 tap-highlight 一模一樣** ——
所以第一次看到會以為是那條沒修好,往 `-webkit-tap-highlight-color` 方向查然後
一無所獲。Chromium/Android 沒帶 outline utility 的元素聚焦時畫的是
`outline: auto 1px rgb(16,16,16)`:深灰,不是黑,而且 `auto` 在 Blink 下是一圈
**雙色環**。中和層 `[class*="outline-"]` 是**靠 class 名選取**的,構不到「元素
自己什麼都沒帶、由 UA 補上」這種情況 —— 實際命中上一題/下一題、整條分頁列、
底部導覽、筆記內文的 `@題號` 連結。修法是 `.eink :focus-visible` 直接接管畫成
純黑實線,並用 `:not(:where([class*="outline-none"]))` 讓帶 ring 的元素(手風琴
標題、輸入框)維持原樣,否則焦點會有兩層指示。

這個破口有兩層防禦盲區,加測試時要一起繞過:

- **靜態掃描永遠抓不到** —— 平常 `outline-style` 是 `none`,只有 `:focus-visible`
  成立的那一瞬間才變 `auto`。得真的用 **Tab** 把焦點移上去(`.focus()` 不一定被
  判定成 focus-visible)。
- **拿 WebKit 驗會全綠** —— 這是 Blink 的 UA stylesheet 行為。整個 e2e 套件為了
  iOS 跑 WebKit,但回報的裝置是 BOOX,BOOX 是 Android。`eink.test.mjs` 因此為這
  幾條**另外開一個 chromium**,理由寫在該處。
- 正面斷言要數的是**看得見的**外框:全站 30 處 `focus:outline-none` 的外框是 2px
  透明,計進去的話「有量到東西」必然成立,測試就退化成空掃的綠燈。

**第四個是原生控制項繪製,而它是這一類裡最隱蔽的 —— 沒有任何 API 讀得到。**
Tailwind preflight 給每個 `<button>` 設 `-webkit-appearance: button`(為了修 iOS
Safari),那會讓瀏覽器改用**平台的原生按鈕外觀**畫底,而 Android(BOOX)的 Material
按鈕底是灰的。三層偽裝疊在一起,前後查了兩輪才定位到:

- **原生繪製不出現在 `getComputedStyle` 裡** —— `background-color` 永遠讀到
  preflight 給的 `rgba(0,0,0,0)`,所以整套顏色掃描全綠。`::placeholder` 至少還是
  個偽元素讀得到,這個連偽元素都不是。
- **macOS/桌機 Chromium 根本不畫**。本機怎麼測、連讀像素都是白的。
- **只要作者給了不透明背景就會被蓋掉**,而 preflight 的 `transparent` 不算(等於
  沒背景)。於是中和層把「class 含 `bg-*`」的按鈕塗成 `#fff`,**意外**替那些擋掉了
  原生繪製 —— 只有 class 裡一個 `bg-` 都沒有的按鈕露出灰底。

**定位它靠的是使用者給的四筆對照,不是任何工具**,而那四筆的 class 幾乎一樣:

| 元素            | tag      | class 含 `bg-`       | 現象                                    |
| --------------- | -------- | -------------------- | --------------------------------------- |
| 民國 xx 年      | `a`      | ✗                    | 正常(`<a>` 的 appearance 本來就是 none) |
| 上一題/下一題   | `button` | ✗                    | **灰底**(class 與上一行一字不差)        |
| 複製為 Markdown | `button` | ✓ `hover:bg-ink-100` | 正常(被中和層塗成不透明白)              |
| 收藏            | `button` | ✗                    | **灰底**                                |

能同時解釋這四筆的假設只有一個。**下次再收到「某些元件在 e-ink 有灰底、另一些
沒有」,先問的不是「哪個元件壞了」,而是「有灰跟沒灰的那兩組,差在哪一個屬性」**
—— 掃描全綠時,對照組就是唯一的儀器。

修法是 `.eink` 下把按鈕類的 `appearance` 關成 `none`,不要依賴「剛好有沒有背景」。
放在中和層通則**之前**,specificity (0,2,1) 低於通則 (0,3,0) 與撈回層,所以
`bg-accent` 的實心黑底、`.eink-invert` 內的透明按鈕都不受影響。只碰按鈕類 ——
checkbox/radio/range/select 的原生外觀是要留的(靠 `:root.eink` 的 `accent-color`
上色)。測試驗的不是顏色(驗不到),是 `appearance` 這個**讀得到的代理指標**。
順帶一提:這個 bug 在 light/dark 的 Android 上同樣存在,只是灰底在 LCD 上看起來
像正常的按鈕外觀,沒人會回報。

**第五個破口是「每顆按鈕都給不透明白底」自己的代價:焦點環被蓋掉。** 焦點環無論
是 ring(box-shadow)還是中和層補的 outline,都畫在**元素自己**那一步,而 in-flow
的後續兄弟在 tree order 之後才畫背景 —— 展開的手風琴,子標題按鈕正是父標題按鈕的
後續兄弟。light/dark 下那些背景是透明的,什麼都不會發生;e-ink 下每顆按鈕帶著一塊
實心白,父標題的焦點環下緣就被整條抹掉,只剩 `pl-6` 縮排露出的一小段(量出來
678px 寬的按鈕底邊只剩 28px)。**換成 outline 解不掉** —— Blink 沒有把 outline 提到
stacking context 的最後畫,實測跟 box-shadow 一樣被蓋。唯一有效的是讓聚焦元素本身
變成 positioned(`.eink :is(:focus, :focus-visible)` 加 `position: relative;
z-index: 1`),它才會整個晚於 static 兄弟繪製;已定位的元素要用
`[class*="absolute"|"fixed"|"sticky"]` 排除,改寫它們的 position 會弄壞版面。
這條**只能量像素**:`getComputedStyle` 讀到的 box-shadow / outline 完全正常,壞掉的
是繪製結果 —— 測試因此截圖後畫回 canvas 數黑點,並且**同時量上緣當對照組**(上緣沒
有東西蓋得到,它一起垮就表示量錯了位置,而不是修好了)。

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

**上面那些測試全部在 e-ink 底下跑,所以它們結構性地看不到反方向的失敗:
這一層漏到亮/暗主題上。** 那種錯不報例外、不被顏色掃描抓到(它只在 e-ink 下
跑),使用者看到的只有「怪怪的、有點太亮」—— 一句很難對應回任何一行程式的話。
兩層守門補這個方向,而且**它們防的不是同一件事,不能互相取代**:

- **`frontend/src/lib/einkIsolation.test.ts`** —— 純文字掃 `styles.css` 的 e-ink
  區塊,每條選擇器都必須帶 `eink`。抓的是「規則掉了 `.eink` 前綴」。
  ⚠️ 逗號要在**括號深度 0** 才算分隔符:`:is(:focus, :focus-visible)` 與
  `:where([class*="absolute"], …)` 內部的逗號不是。天真的 `split(',')` 會把一條
  規則切成好幾段然後回報三條不存在的違規 —— 實際踩過,差點去「修」一條本來就
  正確的規則。所以那支測試自己也有一條測試在守這個解析器。
- **`eink.test.mjs` 的「亮模式不受 e-ink 干擾」** —— 在瀏覽器裡列出所有含
  `eink` 的規則,斷言一條都沒命中元素。它涵蓋靜態檢查看不到的 **Tailwind
  `eink:` variant utility**(打包時才生出來,不在 styles.css 裡),而且**走的是
  切換路徑**:按四下主題鈕繞 light→dark→eink→system→light,抓的是「切回來時
  `.eink` 沒被移除」。全新載入驗不到這條 —— 而那正是調 e-ink 那幾天最常走的路。

寫這兩支時踩到的坑,值得記著:**不能用 `if (r.cssRules)` 判斷 CSSRule 是不是
群組規則。** 支援 CSS Nesting 的引擎(Chromium)給每一條 `CSSStyleRule` 都掛了
`cssRules`,值是空的 `CSSRuleList` —— 空歸空,它是 truthy。照那樣寫會把所有普通
規則當成群組、遞迴進空清單然後跳過,一條都收不到。當時是靠「至少要找到 20 條
eink 規則」那個正面斷言擋下來的,否則就是一支永遠全綠的空測試。

### 歷屆考題面板: 表建好了不代表回填了,而回填貴到沒人跑

`/lectures/:slug` reader 右欄第三個 tab,顯示「這張投影片教到的歷屆 MCQ」
(`worker/routes/lectures.ts` 的 `GET /:slug/questions?page=N`,純讀
`lecture_page_questions` join `questions`,runtime 零 AI 呼叫)。設計:
`docs/plans/2026-07-23-slide-mcq-links-design.md`。

**2026-08-23 回報「這一頁都沒有歷屆考題」,查下去發現不是這一頁的問題 ——
`lecture_page_questions` 在 production 整張表是空的,7 個講義、709 頁一筆都沒有。**
migration、worker route、前端面板全部照設計做好了,唯獨最後一步「離線 pipeline
算完寫回 D1」從沒真的執行過。原始設計的 `scripts/build-slide-mcq-links.ts`
逐候選呼叫 Workers AI LLM 判定「這題是否測驗這頁教的內容」——709 頁 × 每頁數十個
候選,全跑完是上萬次 Workers AI 呼叫,遠超 free tier 10K neurons/day。這張表因此
卡在「建好了但沒人跑得起回填」,跟 `study-enhancements` 分支 M2/M6 等 Vectorize
回填卡住是同一種「表存在 ≠ 有資料」的坑 —— 加新的「離線算好、存 join 表」類功能時,
上線前要跑一次 `SELECT COUNT(*)` 確認回填真的做完,不能只憑 migration 有跑過。

**這次改用 27 個 subagent 平行回填,不再依賴 Workers AI:**

- 不用 SQLite FTS 做關鍵字比對候選。`questions_fts` / `lecture_pages_fts` 用的
  `unicode61` tokenizer 不會切中文詞 —— 連續的 CJK 字元被當成**一個** token,
  同一個醫學名詞出現在兩個不同句子裡,字面上幾乎不會是同一個 token,比對形同虛設
  (同「題幹否定詞」那節 tokenizer 對中文不友善的老問題)。
- 每個 subagent 拿到:全部歷屆考題(~1100 題)的精簡摘要(id / year / group /
  tags / stem 前 70 字)+ 一個講義裡一段(~25 頁)頁面全文,直接用血液腫瘤學知識
  判斷「這頁投影片的內容主要就是在教摘要裡哪些題目」,不透過任何字面比對規則。
  question_id 要求逐字照抄摘要裡的 id;回填腳本驗證過所有 848 筆沒有一筆是編造的。
  每頁上限 6 題、信心分數 < 0.5 不列(跟原設計 `TOP_N_PER_PAGE`/門檻精神一致)。
- **某個 chunk 回傳 0 筆不代表 subagent 偷懶,可能是題庫真的沒收那個主題。**
  交叉查過:lecture-7(兒科血液腫瘤)講述 neuroblastoma 的那幾頁比對出 0 筆,
  直接對 `questions.stem LIKE '%neuroblastoma%'` 查證,題庫裡真的一題都沒有。
  之後如果有人回報「這頁明明該有題卻是空的」,先查題庫裡是否真的存在對應題目,
  不要預設是比對邏輯壞掉。
- `method` 欄位沿用既有的 `'llm'` 值(schema 註解本來就是「代表語意/LLM 判定來源」,
  沒有為 subagent 另開第四種值)。
- 寫入沿用原設計的 delete-then-insert per slug,冪等 —— 之後只加一個新講義,
  可以只針對那個 slug 重跑,不用整批重來。跑之前先 `--local` 驗證(尤其是驗證
  回報案例那一頁真的有結果),再 `--remote` 推上去,同原始腳本的慣例。
- 這是**一次性手動回填**,沒有寫成常態 pipeline / cron。原本的
  `scripts/build-slide-mcq-links.ts` 還在 repo 裡,但它的 Workers AI 逐候選判定
  模式在這個題庫規模下不現實 —— 之後新增講義要回填,照這節描述的做法(subagent +
  完整題目摘要)重做一輪,而不是直接跑那支腳本。

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

**「貼在 header 底下」的東西吃 `--chrome-top`,包含不在 `<main>` 版面裡的那些。**
`/exam/:sid` 的計時列是 `sticky top-0` —— 那條規則本身沒有錯,同一份程式碼裡另外
兩處(講義閱讀器工具列、全螢幕筆記卡)都是對的:**它們在自己的捲動容器裡,而容器
頂端本來就在 header 底下**。錯的只有「跟著 window 捲」的那一種,而 header 是
`fixed top-0 z-30` 且不透明,於是它黏住的位置正好在 header 底下(#139)。量出來:
桌機捲動後整條看不見,手機只露出下緣 20px —— 考試中往下捲就看不到剩餘時間與交卷,
捲回頂端又出現,像隨機故障。

**靜態掃描抓不到這個形狀**(`sticky top-0` 三處都一樣,差別在祖先是不是捲動容器),
所以守門在 `frontend/e2e/exam-timer-bar.test.mjs`,判準是「計時列中央那一點,
`elementFromPoint` 回來的東西在不在 app header 裡」。

⚠️ 那支測試不能只靠 fixture:`running_since` 是絕對時間戳,**靜態 fixture 給什麼
都會過期** —— 給過去的時間,client 算出已超過 100 分鐘上限,一進頁面就自動交卷;
給 `null`(暫停)則整份題目不渲染,頁面只剩「已暫停作答」、捲不動 128px。所以
fixture 只提供形狀,「現在」由測試在請求當下用 `ctx.route` 注入。

### 捲動時收起頂端/底部列: `--header-h` 從此有兩個角色

`.chrome-hidden` 掛在 `<html>` 上,判定在 `lib/autoHideChrome.ts`(純函式,
**不 import 任何東西**,所以在 `node --test` 底下載得起來),接線在
`hooks/useAutoHideChrome.ts`,位移全部在 `styles.css`。用 class 而不是 React
state:要動的東西散在三個檔案,而捲動事件是連續的 —— 放進 state 等於每一幀
重新 render 整棵樹(含 TipTap)。

**最容易弄錯的是 `--header-h` 現在有兩個角色,而收合時它們的答案相反:**

| 角色                     | 例子                                             | 收起時                 |
| ------------------------ | ------------------------------------------------ | ---------------------- |
| 替 fixed header **佔位** | `<main>` 的 `pt`                                 | **不動**(`--header-h`) |
| **停靠**在 header 底下   | `.substick`、離線橫幅、`Question.tsx` 兩條分頁列 | 跟著走(`--chrome-top`) |

`<main>` 的 `pt` 一起變的話,收合的那 0.22 秒整份內容會跟著位移 —— 比省下來的
113px 糟得多,而且每次捲動都發生。有一條靜態測試釘著它不准吃 `--chrome-top`。

- **`black-translucent` 讓這件事多一個零件。** header 收起來之後,狀態列那一塊
  是頁面的,內容會直接從動態島底下穿過去。所以留了 `.status-scrim` —— 一個
  `height: env(safe-area-inset-top)` 的 fixed 底色,header 在時被蓋住,收起時遞補。
  **又是一條在一般瀏覽器裡看不出來的規則**(inset 是 0,它高度也是 0),驗證只能
  靠注入 inset 後看畫面,或靜態掃「兩半都在」。
- **底端橡皮筋的 `lastY` 要夾回 `maxY`,不能記成過捲後的值。** 這是單元測試抓到的:
  擋住過捲的那幾格、卻放行「回到範圍內」的那一格,等於沒擋 —— iOS 捲到底再拉一下,
  彈回來那段是負 delta,兩條列就會在使用者只是撞到底時冒出來。頂端不必另外處理,
  `revealAbove`(64px)已經涵蓋。
- **掛載時要以當下的 `scrollY` 起算。** 從捲到一半的位置進頁面(換路由、返回上一頁),
  以 0 起算的第一次量測 delta 會是整個 `scrollY` —— 一載入就自己收起來。
- **換方向時累積要歸零。** 沿用舊累積的話,往下捲 400px 之後得往回捲 400px 才有反應,
  手感是「怎麼拉都拉不回來」。
- **opt-out 的判準是「這一頁有沒有東西消失了會出事」,不是「這一頁長不長」**
  (`chromeAutoHideAllowed`):`/exam*` 有計時與交卷;`/chat`、`/lectures/:slug`、
  `/play` 的版面是 `100dvh - var(--header-h)` 的自有捲動容器。**離開 opt-out 路由時
  要主動清 class**,否則新頁面會頂著一條收起來的 header 而且捲到頂也回不來。
- **只在 `<md`**,CSS 與掛鉤各擋一次(CSS 那層保證「就算 class 掛上去也不會有事」)。

驗證分兩層:`lib/autoHideChrome.test.ts` 是純函式(方向/閾值/橡皮筋/起算點),
`e2e/auto-hide-chrome.test.mjs` 驗接線(class 有沒有掛上、CSS 有沒有真的位移、
內層 sticky 有沒有跟著走、`<main>` 留白有沒有保持不動)。**每一條 e2e 都先斷言
「東西找得到」再斷言行為** —— 停用功能後確認過 6 條裡有 4 條會紅。

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
- **`OnlineUsers` 分兩種形態,各自的寬度上界都固定。** 原本整塊推到 `lg`,理由是
  「寬度隨線上人數變動,是整條 header 唯一寬度不固定的東西」。但真正讓斷點算不準
  的不是「會變」,而是**最大寬度不可預測** —— 頭像列 1 顆到 5 顆差了 100px 以上。
  現在 `md`–`lg` 只出一顆計數徽章(綠點 + 人數,`tabular-nums` 讓數字等寬,實測
  固定 35px),`lg` 起才展開頭像列(112px)。上界固定之後斷點就算得準,而
  `md`–`lg` 那段也拿回了視覺重量 ——「有人在線」不該只在寬螢幕看得見。
  **這是這類元素的通則**:寬度會變沒關係,把**上界**釘死就行;做不到的話才退回
  「往上挪一階」。
- **品牌是唯一可讓步的元素**(`min-w-0 truncate`,其餘 `shrink-0`)。這是結構性
  保證,不是階梯的替代品:品牌名是 `config.toml` 來的,fork 換個長名字階梯就不準了。
- 守門在 `frontend/e2e/overflow.test.mjs`,寬度**繞著斷點兩側取樣**
  (639/640、767/768、1023/1024、1279/1280)。**`users_online.json` fixture 要保持
  非空** —— 空的時候 700/767/820/1024 四個寬度全是綠的,而那正是漏掉的原因。
  只認頁面層級的捲動;內部自己捲的容器(寬表格、程式碼區塊)是刻意設計。

**「強制手機版面」只有改 viewport meta 這一條路**(`lib/viewportMode.ts` +
`profile/DisplayCard.tsx`)。版面幾乎都寫在 `md:`/`lg:` utility 裡,而 media query 問的是
視窗寬度、不是任何 React state —— 要嘛把三千多處改成 container query,要嘛讓瀏覽器
相信視窗就是那麼窄。寬度 560 是同時小於 `sm`(底部導覽列才會回來)與 `md`(才拿得到
手機版面)。**桌機瀏覽器完全忽略 viewport meta**,所以整張卡只在 `(pointer: coarse)`
出現:一個在 Mac 上按了沒反應的開關比沒有更糟。**目錄那一項要用同一個判準濾掉** ——
`ProfileToc` 對不存在的錨點是「點了沒反應」而不是壞掉,那比沒有這一項更糟。
**而且這個效果在測試環境驗不到** ——
Playwright 兩個引擎都用 `setDeviceMetricsOverride` 把版面視窗釘死,meta 寫對了
`innerWidth` 也不會變,所以測試只鎖「寫進去的內容對不對」。元件因此在點擊後 300ms
自己量一次寬度,沒變就重新載入(從 HTML 解析進來的 meta 是所有引擎都認的)—— 常見
情況不會重整。

它**原本是左下角一顆 FAB**,#135 搬進 `/profile` 的「顯示」卡。判準是:設定一次就
不會再碰的東西不該佔著每一頁的左下角(還會壓住內容),那個位置留給每天都在按的
番茄鐘與回到頂端。搬家順帶解決了「重新載入會弄丟編輯中的草稿」—— 個人頁沒有草稿。

**FAB 的垂直位置只准吃 `--bottom-nav-h`,不要再掛第二個斷點。** 番茄鐘原本寫的是
`bottom-[calc(var(--bottom-nav-h)+1rem)] sm:bottom-6` —— 那個 `sm:` 是「底部導覽列
到 `sm` 為止」那個年代留下來的。導覽列延到 `md` 之後 `--bottom-nav-h` 跟著改,斷點
沒跟著改,於是 640–767 整段番茄鐘正好壓在導覽列最右邊那顆(收藏)上。`--bottom-nav-h`
本身就已經回答了「導覽列在不在」,再寫一次斷點就是第二個真相來源,而且兩者不同步時
完全無聲。守門在 `frontend/e2e/fab-overlap.test.mjs`(同樣繞著 639/640、767/768 取樣;
左下角現在只剩回到頂端一顆 —— 強制手機版面那顆已於 #135 搬進 `/profile`)。
**它先斷言「找得到番茄鐘」再斷言不重疊** —— 少了前半段,選擇器一腐爛就變成空掃的
綠燈,跟 `users_online.json` 那個坑同一種。

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

### 備份我的紀錄: zip 在瀏覽器裡組,不在 Worker 裡

個人頁的「備份我的紀錄」(`/api/backup/*`,`frontend/src/lib/backupLayout.ts`)
把這個帳號的全部紀錄倒成一個 zip:一題一個 JSON(題目、共筆詳解 + 我的作答、
信心、筆記、畫記、收藏)、一場模擬考一個 JSON、一份講義一個 JSON、其他筆記
一則一個,外加一份 `CLAUDE.md` 讓 Claude 打開整個資料夾就看得懂。

- **打包在 client。** 實測單一使用者的 `personal_notes` 就有 3976 則 / 35.8 MB
  (再加 1100 題與 1.85 MB 的共筆詳解)。free plan 一次請求 10ms CPU、128 MB
  記憶體,`zipSync` 一次吃下 38 MB 不可能;改成串流 STORE 也一樣,CPU 與資料量
  成正比。Worker 只出分頁 JSON —— 那是這個站每天都在做的事。
- **每一支查詢都釘死 `user_email`。** 個人筆記在畫面上寫「僅你可見」,備份不能
  是那句話的例外。題目與共筆詳解是公開的,照原樣附上(少了題幹,作答紀錄沒有
  東西可分析)。
- **分頁一律 keyset(`... > ?`),不用 OFFSET。** 下載途中資料被改動時 OFFSET
  會漏列或給重複列,而使用者不會發現。client 端另外擋「游標沒有前進」——
  那代表 `ORDER BY` 跟游標欄位對不上,不擋的話是無窮迴圈。
- **`/api/backup/*` 不進 `sw-guards.ts` 的 `CACHEABLE_API`**(有測試鎖著)。
  被快取住的話備份檔裡是上一次的狀態,而檔名與 `manifest.generated_at` 都宣稱
  是現在 —— 一份說謊的備份比沒有備份更糟。
- **收藏不在 `review_progress` 裡。** 上面「作答歷史」那節寫的
  「`review_progress` … 也帶 `bookmarked` / `bookmark_folder_id`」**已經過時**:
  正式機的那張表沒有這兩個欄位,收藏早就搬到 `bookmark_folders` /
  `bookmark_items`。照著文件寫會拿到 `no such column: bookmarked` —— 這是寫這個
  功能時真的踩到的。
- **圖片不打包**,`/img/<key>` 保持原樣。血液抹片那類圖會讓體積再翻一倍,而
  文字分析不受影響。
- 驗證分兩層:`backupLayout.test.ts` 是純函式(併檔正確性),
  `frontend/e2e/backup.test.mjs` 走真的瀏覽器 —— 按下按鈕、抓完 12 支端點、
  壓成 zip、觸發下載,再把下載到的檔案解開檢查。後者涵蓋的是單元測試碰不到
  的那一半(fflate 的 worker thread、`URL.createObjectURL`、`<a download>`)。

## 部署管線: 判準是 denylist,而「跳過」不准是綠的

`.github/workflows/deploy.yml` 一支涵蓋兩邊:push 到 `main` → `classify` 決定要
部署什麼 → `pages` / `worker` 兩個 job 各自跑。判準抽在
`scripts/lib/classify-deploy.sh`(有測試),**不是內嵌在 YAML 裡** —— 內嵌的
shell 只能靠「推上去看看會不會動」來驗,而部署邏輯最不該用那種方式驗。

前身是 `deploy-pages.yml` + `deploy-worker.yml` 兩支,各自帶一份 guard,而**判準
寫反了**:它問的是「有沒有非 frontend 的檔案」(allowlist),該問的是「有沒有
**真的需要人**的檔案」。於是 `CLAUDE.md`、`package.json`、`scripts/` 底下任何一個
檔案都會讓整次部署跳過。拿最近 30 個 commit 對兩套判準各跑一次:

|             | 舊  | 新  |
| ----------- | --- | --- |
| 前端部署    | 10  | 21  |
| Worker 部署 | 1   | 3   |
| 真的需要人  | —   | 0   |

**而最傷的不是「跳過」,是跳過之後那個綠勾。** job 顯示 ✅、步驟全是 `skipped`,
你看到勾勾會以為上線了 —— 跟 `users_online.json` 空 fixture、
`pnpm build >/dev/null 2>&1` 吃掉建置失敗是同一種假綠。所以現在需要人工時
`classify` **直接讓 job 紅**。這條路在那 30 個 commit 裡一次都沒走到,紅燈不會
變成噪音。

- **需要人工的只有三種檔案**:`migrations/**`(要 `d1 migrations apply --remote`)、
  `wrangler.example.toml`、`config.example.toml`(新 binding / 新設定值要先更新
  `WRANGLER_TOML` / `CONFIG_TOML` secret,否則 Worker 會找不到 class 而部署失敗
  —— 2048 的 `PLAY` binding 踩過)。
- **`.github/workflows/**` 刻意不在清單裡。\*\* 改了 pipeline 之後跑的本來就是新版
  的 pipeline,擋下這一次不會讓任何事更安全。
- **`.claude/skills/**`算 worker 變更** —— 它們被`pnpm gen:bundles`快照進`worker/generated/\*.ts`。CI 現在跑兩份 bundle(舊版只跑 mcq,所以 bank-ingest
的 skill 改了之後 `/api/me/bank-skill` 下載到的一直是舊版)。
- **`on.push` 不帶 `paths` 過濾。** 過濾掉的 push 連 job 都不會建立,也就沒有任何
  地方能說「這次沒有部署,因為 X」。讓 classify 永遠跑並留下 summary。
- **`cancel-in-progress: false`。** 砍掉跑到一半的部署,留下的是「Worker 新、前端
  舊」這種看起來像快取問題的半套狀態。
- **Pages 明寫 `--branch=main`。** wrangler 從當前 git 分支推導環境,推導錯的話
  東西會靜靜上到 Preview(見上面 worktree 那條坑)。這裡不靠推導。

**兩個 job 都有部署後驗證,因為「部署指令成功」跟「使用者拿得到新版」是兩件事。**

- Pages:抓線上首頁,斷言它引用的 bundle 檔名等於剛建出來的那一個。這同時證明了
  上的是 Production —— Preview 部署不會改變自訂網域服務的內容。**要重試**:實測
  部署完當下第一次讀還是舊的,一次定生死會變成不穩定的紅燈。
- Worker:打 `/api/me`(Access-bypassed 的 auth probe),斷言 **401 + JSON**。回
  HTML 表示答話的是 Access 的登入頁、route 沒掛上 —— 就是 PWA 那節講的「302 看
  起來像 200」同一個陷阱。

## Cost Awareness

This is designed to fit in **free tier indefinitely** for 20 users. If a feature would push past free tier, call it out explicitly. Don't silently add paid services. Note: SQLite-backed Durable Objects (`new_sqlite_classes`) ARE available on the free plan (the chat lobby uses one) — only KV-backed DO storage requires Workers Paid.

## Owner Notes

- Original spec from user: 1000 題, 10 年, 共筆詳解, 留言討論, @mention, 全真模擬, RWD, all Cloudflare
- AI features are optional add-ons, not core
- Future migration path to真共編 is reserved but not implemented

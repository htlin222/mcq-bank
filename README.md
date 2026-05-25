# Q&A bank — collaborative MCQ study system

Multiple-choice question bank + collaborative wiki-style explanations,
**full-stack on Cloudflare free tier**. Designed for small invite-only
study groups (5–50 users). This repo is the 2026 Taiwan hematology
subspecialty exam ("hema-2026") instance, but every per-fork identifier
lives in `config.toml` — read **[Forking this codebase](#forking-this-codebase)**
to spin up your own deployment.

- ~1000 questions, organised by year + category
- Two study modes: review (single question, collaborative explanation, threads)
  and full mock exam (timed, scored, error review)
- 5–50 user small group (CF Access whitelist, email OTP, no passwords)
- Free tier for development and production

## 功能

- **複習模式**:單題練習,即時看答案,協作 wiki 詳解 (TipTap rich text + 圖片)
- **全真作答**:整年模擬考,計時、成績、錯題回顧
- **討論串**:每題留言 thread,@提及成員,in-app 通知
- **零信任認證**:Cloudflare Access,email allow-list + OTP,**無密碼**
- **詳解共編**:Pessimistic lock + 版本歷史 (未來可升 Yjs CRDT)
- **AI 輔助** (Workers AI 免費額度):詳解摘要、tag 建議、改寫
- **RWD**:手機/平板/桌機

## 技術棧

| 層 | 技術 |
|---|---|
| Frontend | React 18 + Vite + TypeScript + TailwindCSS + TipTap |
| Backend | Cloudflare Workers + Hono |
| DB | Cloudflare D1 (SQLite) |
| 物件儲存 | Cloudflare R2 (圖片) |
| 認證 | Cloudflare Access (Zero Trust) |
| AI | Cloudflare Workers AI |
| 託管 | Cloudflare Pages |

## Forking this codebase

Everything fork-specific lives in three files; all three are gitignored
and shipped as `.example` templates. Either run the interactive helper:

```bash
./scripts/setup.sh        # asks for slug / host / admin email / CF token
```

…or copy the templates by hand:

```bash
cp config.example.toml   config.toml
cp wrangler.example.toml wrangler.toml
cp .env.example          .env
$EDITOR config.toml wrangler.toml .env
```

What goes where:

| File              | Tracked? | Holds                                                   |
|-------------------|----------|---------------------------------------------------------|
| `config.toml`     | ❌       | slug, brand strings, public host, CF resource names     |
| `wrangler.toml`   | ❌       | Worker bindings (must match `config.toml [project]`)   |
| `.env`            | ❌       | CF API token, account ID, roster sheet URL, GH PAT      |

After editing, `./scripts/deploy.sh` creates the D1 DB, R2 bucket, Worker,
and Pages project from those values. Resource names everywhere in scripts
come from `config.toml [project]` (via `scripts/lib/cfg.mjs` /
`scripts/lib/cfg.sh`), so changing the slug there propagates.

Reference deployment (this fork):

| Resource | Value |
|---|---|
| URL | https://hema-2026.hsiehting.com |
| Worker | `hema-2026-api` |
| D1 | `hema-2026-db` |
| R2 | `hema-2026-uploads` |
| Access team | `htlin.cloudflareaccess.com` |

## 本地開發

```bash
./scripts/setup.sh                        # (first time) writes config/wrangler/.env
pnpm install                              # worker deps
cd frontend && pnpm install && cd ..      # frontend deps
pnpm db:migrate:local                     # local D1 schema + sample data
pnpm dev                                  # wrangler dev (:8787)
cd frontend && pnpm dev                   # in another terminal — vite (:5173)
```

開瀏覽器到 http://localhost:5173 即可使用,Vite proxy 會把 `/api` 和 `/img` 轉到 :8787 並注入 `X-Dev-Email`。

要改本機登入用的 email,改 `config.toml [dev] dev_email`。

## 部署

`.env` 需要 `CF_API_TOKEN`、`CF_ACCOUNT_ID`、`PAGES_DOMAIN`、`ADMIN_EMAILS`、`ROSTER_CSV_URL` (見 `.env.example`)。

```bash
./scripts/deploy.sh         # D1 / R2 / Worker / Pages,一鍵
node scripts/sync-access.ts # 建/同步 Access app + policy + Worker secrets
```

兩個都是 idempotent,可以重複跑。

## 匯入真實題庫

把 11 年 × 100 題整成 CSV (`year,number,group,stem,option_a..e,answer,tags,difficulty,source`),`year` 用民國 (104..114),`group` 用 `內科` 或 `共同`:

```bash
node scripts/import-questions.ts ./questions.csv          # 上 prod
node scripts/import-questions.ts ./questions.csv --local  # 上本地測試
```

驗證規則 (任何一筆失敗就整批拒絕):
- `year ∈ 104..114`
- 1..70 必須 `group=內科`,71..100 必須 `group=共同`
- 每年總計 70 內科 + 30 共同
- (year, number) 全域唯一
- `answer` 字母對應到實際存在的 option

匯入前可選擇清除範例:

```bash
wrangler d1 execute hema-2026-db --remote --command 'DELETE FROM questions WHERE year = 100;'
```

## 資料結構

見 `migrations/0001_initial_schema.sql` + `0003_year_and_groups.sql`。

- `users` - 使用者 (email = identity from Access JWT)
- `questions` - 題目 (id = `${year}-${number padded 3}`、`group` ∈ {內科,共同})
- `question_tags` - 多對多自由標籤
- `explanations` - 共筆詳解 (TipTap JSON + lock)
- `explanation_history` - 版本歷史
- `comments` - threaded 留言
- `mentions` - @提及索引
- `notifications` - 通知 inbox
- `exam_sessions` / `exam_answers` - 模擬考
- `review_progress` - 個人複習狀態 (含 bookmark)

## 帳務估計

20 人重度使用,預期 **$0/月** — 全部落在 free tier 內 (Workers/Pages/D1/R2/Access 50 seat/AI 10K neurons 日)。

未來如果改 Durable Object 真共編,要 Workers Paid plan **$5/月**起。

## License

MIT

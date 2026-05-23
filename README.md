# hema-2026 共筆題庫

血液腫瘤次專科考古題複習 + 共筆系統,**全棧 Cloudflare**。

- 民國 104..114 年 (= 2015..2025) × 100 題 / 年 = 1100 題
- 每年:**70 內科** + **30 共同** (兒科 + 成人共同題)
- 5–20 人小團體用 (CF Access whitelist)
- 開發/部署皆在 free tier

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

## Production

| 資源 | 值 |
|---|---|
| URL | https://hema-2026.hsiehting.com |
| Worker | `hema-2026-api` (routes: `/api/*`, `/img/*`) |
| Pages project | `hema-2026` |
| D1 | `hema-2026-db` |
| R2 | `hema-2026-uploads` |
| Access app | `hema-2026 共筆` (session 30d, email OTP) |
| Access team | `htlin.cloudflareaccess.com` |

Allow-list 自 Google Sheet 同步 (見 `.env` `ROSTER_CSV_URL`)。

## 本地開發

```bash
pnpm install                              # 安裝 worker deps
cd frontend && pnpm install && cd ..      # 安裝 frontend deps
pnpm db:migrate:local                     # 建本地 D1 schema + 灌民國 100 年範例
pnpm dev                                  # 啟動 wrangler dev (:8787)
cd frontend && pnpm dev                   # 另一 terminal 起 vite (:5173)
```

開瀏覽器到 http://localhost:5173 即可使用,Vite proxy 會把 `/api` 和 `/img` 轉到 :8787 並注入 `X-Dev-Email`。

要改本機登入用的 email,改 `frontend/vite.config.ts`。

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

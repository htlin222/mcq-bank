# 維運手冊

日常維護這套系統需要知道的事。詳細的初次部署流程見 repo 內 `CLAUDE.md`（"setup / deploy" 一節）與 `README.md`。

## 本地開發

```bash
./scripts/setup.sh                    # 首次：互動式產生 config.toml / wrangler.toml / .env
pnpm install
cd frontend && pnpm install && cd ..
pnpm db:migrate:local                 # 本地 D1 schema + 樣本資料
pnpm dev                              # terminal A：wrangler dev (:8787)
cd frontend && pnpm dev               # terminal B：vite (:5173)
```

- Vite proxy 會把 `/api`、`/img` 轉到 :8787 並注入 `X-Dev-Email`；`.dev.vars` 的 `CF_ACCESS_TEAM_DOMAIN=localhost` 啟用 Access bypass。
- 改本機登入 email：`config.toml [dev] dev_email`。
- **常見坑：port 8787 被占走**。若本地所有 API 回 500/404，先查是不是 OpenEvidence MCP relay daemon 佔了 8787，不是程式碼問題。
- 本地 D1 在 `.wrangler/state/v3/d1/`；砍掉重來：`rip .wrangler/state`。

## 部署

```bash
./scripts/deploy.sh                               # D1 / R2 / Worker / Pages 一鍵，idempotent
node --experimental-strip-types scripts/sync-access.ts   # Access app + policy + Worker secrets + users 種子
./scripts/setup-public-bypass.sh                  # landing / OG / favicon 等 path-scoped bypass
```

`.env` 需要 `CF_API_TOKEN`、`CF_ACCOUNT_ID`、`PAGES_DOMAIN`、`ADMIN_EMAILS`、`ROSTER_CSV_URL`（範本見 `.env.example`）。部署失敗多半是 API token 缺 scope、zone 不在帳號下、或資源名衝突——讀錯誤訊息，不要跳步。

## 資料庫

```bash
wrangler d1 migrations create <db> <name>   # 新增 migration（絕不改已套用的檔）
pnpm db:migrate:local                       # 先本地測
pnpm db:migrate:remote                      # 再上 prod
pnpm db:pull                                # 鏡像 remote → local（單向，local 會被覆蓋）
```

檢視資料：`wrangler d1 execute hema-2026-db --local --command "SELECT ..."`（prod 加 `--remote`）。

## 題庫匯入

CSV 格式：`year,number,group,stem,option_a..e,answer,tags,difficulty,source`；`year` 用民國（104–114），`group` ∈ {內科, 共同}。

```bash
node --experimental-strip-types scripts/import-questions.ts ./questions.csv          # prod
node --experimental-strip-types scripts/import-questions.ts ./questions.csv --local  # 本地
```

- Pre-flight 驗證整批（年份範圍、1–70 內科 / 71–100 共同、(year,number) 唯一、answer 對應存在的選項），任一筆失敗整批拒絕。
- **重要**：importer 不會覆蓋社群已修訂的答案（answer challenge 升級過的題目）。這是修過的 bug，改 importer 時務必保住這個行為。

## 名單（roster）與 Access

- 名單來源是 Google Sheet 發佈的 CSV（`ROSTER_CSV_URL`），email 欄位目前寫死在 column index 3（`scripts/sync-access.ts:194`）。
- 每日 cron 會自動同步 roster → Access policy + D1 `users`；手動跑：`pnpm sync-users`。
- 新成員上線後即出現在 @mention picker（sync 會預先 seed `users` 列）。

## 講義（複習班 PDF）

```bash
pnpm import:lectures        # PDF → R2 + lecture_docs 登錄
pnpm seed:lecture-notes     # 預設頁面筆記
```

## 教科書（選字問 Wintrobe）

教科書走與講義同一條匯入管線，差別在 `kind='textbook'`（migration 0033）：不出現在
`/lectures` grid、無 default notes / annotation（唯讀參考書），只由全站選字 popup 經
`POST /api/textbook/lookup` 進入，以 `/lectures/:slug?page=N` 閱讀。

- **匯入前必須按章節拆冊**：EmbedPDF 目前**一律整份下載**（不發 range 請求），100 MB 單檔會實打實抓 100 MB。拆成 20–40 冊、各 3–8 MB（`mutool` / `pdfcpu` 依內建 outline 在章界切，每冊 `qpdf --linearize`），每冊一列 `lecture_docs`，命名 `wintrobe-chNN`。逐頁文字沿用 `lecture_pages` / `lecture_pages_fts`，FTS 觸發器自動 fan-out。
- **前提是 PDF 有文字層**：掃描影像 PDF 要先 `ocrmypdf`；匯入前抽 3 頁 `pdftotext` 驗證。
- lookup 是**純 FTS、亞毫秒級**：OR 串接選取 token（實測嚴格優於 AND——`Auer rods`、`CRAB criteria`、長句選取用 AND 會回空），僅在長選取 / bm25 低分時才補一手 Workers AI 精煉查詢。

## Telegram 出題機器人

一次性註冊（需 BotFather，無法自動化）：

```bash
# 1. BotFather /newbot → 取得 token
wrangler secret put TG_BOT_TOKEN         # BotFather 的 token
wrangler secret put TG_WEBHOOK_SECRET    # 自訂一段亂數,setWebhook 會帶上
# 2. config.toml [telegram] bot_username = "..."（前端 deep link）
#    wrangler.toml [vars] TG_BOT_USERNAME = "..."（Worker deep link）
./scripts/setup-public-bypass.sh                         # 讓 /tg/* 走 Access bypass
node --experimental-strip-types scripts/setup-telegram.ts  # setWebhook / setMyCommands / menu button
```

- **關鍵：`wrangler.toml [[routes]]` 必須登記 `<host>/tg/*`**，否則 `/tg/*` 會落到 Pages 被當 SPA 路由（POST 回 405），Telegram webhook 永遠收不到。
- 三個設定值（`TG_BOT_TOKEN` / `TG_WEBHOOK_SECRET` / `TG_BOT_USERNAME`）皆未設時：webhook 靜默 200、cron 推播 no-op、`/api/telegram/link-code` 回 501——**沒設定不會壞站**。
- Cron：`crons = ["*/10 19-21 * * *", "0 * * * *"]`；`scheduled()` 依 `event.cron` 分派（前者 roster 同步 + 筆記 relink drain，後者每小時比對各人本地時段推每日題）。單次 tick 上限 50 人以防爆量。
- 綁定成員自助：app → 個人頁 → 產生 deep link → 開連結 → bot 收 `/start <code>` 完成 `chat_id ↔ email`；用 `/today` 驗證。

## 除錯

| 需求 | 指令 / 位置 |
|---|---|
| Prod Worker log | `pnpm tail`（wrangler tail） |
| Pages log | Dashboard → Pages → 專案 → Functions |
| 型別檢查 | `pnpm typecheck` |
| 單元測試 | `pnpm test`（`node --test` 跑 `worker/**/*.test.ts` + 前端純函式測試）——**只涵蓋純函式**，元件 / 整合層仍靠手動 smoke |
| 本地 DB 檢視 | `wrangler d1 execute <db> --local --command ...` |

## 安全底線（動code前先讀）

- R2 bucket 永不公開；圖片/PDF 一律走 Worker proxy。
- 不加 app 層 auth；身分只來自 Access JWT 的 email。
- DB 只存 TipTap JSON，渲染只走 read-only TipTap。
- 錯誤回應不外洩內部細節（已修過 error-detail leakage，維持住）。

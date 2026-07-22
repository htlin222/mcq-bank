# Telegram 出題機器人 — 設計文件

日期：2026-07-22
分支：`worktree-telegram-bot`

## 一句話

一個跑在既有 Cloudflare Worker 裡的 Telegram bot：使用者掃連結加入、把
Telegram 帳號綁到自己的 app email，之後每天在設定的時段收到一題（優先
複習到期題），可在聊天裡點選作答、即時揭曉，也能挑年份開一場進行式小
測驗。所有作答計入既有的 `attempts` / `review_progress`，與網頁版同一份
學習進度。

## 已確定的設計決策（brainstorming 結論）

1. **身分**：綁定既有帳號。app 內產生一次性 code，deep link
   `t.me/<bot>?start=<code>` 完成 `chat_id ↔ email` 綁定。作答計入共用系統。
2. **推題策略**：FSRS/attempts 到期題優先 → 沒到期就抽沒做過的新題 → 都沒
   了才純隨機。與網頁版學習節奏一致。
3. **測驗形態**：進行式小測驗。選年份 → 選題數（10/20/50）→ 一次一題、
   點選即揭曉 → 最後給分。

## Telegram 最佳實務（本設計採用）

- **Webhook 而非 long-poll**：Worker 無常駐行程，用 `setWebhook`。
- **`secret_token`**：`setWebhook` 帶 `secret_token`，Telegram 每次回呼在
  `X-Telegram-Bot-Api-Secret-Token` header 送回；Worker 以**常數時間**比對，
  非法一律 401。這是防止他人偽造 update 的官方機制。
- **路徑避開 Access**：webhook 掛在 `/tg/webhook`（**不在 `/api/*` 下**，
  所以不吃 `authMiddleware`），並在邊緣把 `/tg/*` 設為 Cloudflare Access
  bypass（Telegram 伺服器無法過 Zero Trust 登入）。
- **Deep linking**：`?start=<payload>` 是官方帳號綁定手法；payload 限
  `[A-Za-z0-9_-]`，≤64 字。
- **inline keyboard + `callback_query`**：作答用按鈕，回呼一律
  `answerCallbackQuery` 收掉轉圈。
- **就地編輯**：揭曉時 `editMessageText` 更新原訊息（標出正解），不洗版。
- **`setMyCommands` + 選單鈕**：`/start /today /quiz /stats /settings /stop
  /help`，並把 menu button 設成 commands。
- **`parse_mode: HTML`**：只需跳脫 `& < >`，比 MarkdownV2 少踩坑。
- **回呼資料 ≤64 bytes**：callback_data 用短前綴（`ans:2024-001:B`）。

## 架構

```
Telegram ──webhook(POST + secret header)──▶ Worker  /tg/webhook  (無 Access)
                                             │
app 網頁 ──POST /api/telegram/link-code────▶ Worker  /api/telegram/* (走 Access)
                                             │
Cron "0 * * * *" (每小時) ─── scheduled() ──▶ runPushTick() ──▶ 送每日題
                                             │
                                             ▼
                                   D1: tg_users / tg_link_codes / tg_sessions
                                       + 既有 questions / fsrs_cards /
                                         review_progress / attempts
```

Worker 無狀態 → 每個 chat 的「目前這題」「小測驗剩幾題」存進 `tg_sessions`。

## 資料庫（migration 0031_telegram.sql）

```sql
CREATE TABLE tg_users (
  chat_id      INTEGER PRIMARY KEY,            -- Telegram 私聊 id
  email        TEXT REFERENCES users(email) ON DELETE CASCADE, -- NULL=未綁定
  username     TEXT,
  first_name   TEXT,
  subscribed   INTEGER NOT NULL DEFAULT 1,     -- 每日推播開關
  push_hour    INTEGER NOT NULL DEFAULT 8,     -- 本地時 0-23
  tz_offset    INTEGER NOT NULL DEFAULT 480,   -- 分鐘,UTC 以東(台北+480)
  year_filter  INTEGER,                        -- NULL=全部年份
  daily_count  INTEGER NOT NULL DEFAULT 1,
  last_push_on TEXT,                           -- 'YYYY-MM-DD' 本地日期,防重推
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX idx_tg_users_email ON tg_users(email);

CREATE TABLE tg_link_codes (
  code        TEXT PRIMARY KEY,   -- base32 隨機
  email       TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,   -- 15 分鐘
  used_at     INTEGER             -- 單次使用
);

CREATE TABLE tg_sessions (
  chat_id     INTEGER PRIMARY KEY,
  kind        TEXT NOT NULL,      -- 'daily' | 'quiz'
  data_json   TEXT NOT NULL,      -- {qid, remaining:[], score, total, year}
  updated_at  INTEGER NOT NULL
);
```

`tg_users.email` 為可空外鍵：未綁定時 NULL，不受 FK 約束；綁定後帳號被移除
會連帶清掉綁定。答題不另建進度表 —— 直接寫既有 `review_progress` + `attempts`
（source=`review`），FSRS 到期查詢僅**讀** `fsrs_cards`，不改其排程狀態
（與網頁「複習答題」路徑一致，anki 排程是另一條寫入路徑）。

## 模組

| 檔案 | 職責 |
|------|------|
| `worker/lib/telegram.ts` | Bot API 薄封裝、HTML 跳脫、常數時間比對、callback 解析（純函式，可測） |
| `worker/lib/tg-select.ts` | 推題挑選：到期 → 未做 → 隨機（讀 D1） |
| `worker/lib/tg-push.ts` | `runPushTick(env, now)` cron 每小時比對本地時段送題 |
| `worker/routes/telegram.ts` | `webhookRoutes`（公開）+ `telegramApiRoutes`（走 Access）|
| `scripts/setup-telegram.ts` | `setWebhook` / `setMyCommands` / menu button 一鍵註冊 |
| `frontend` Profile 卡片 | 顯示綁定狀態、產生 deep link、解除綁定 |

## 互動流程

**綁定**：app → `POST /api/telegram/link-code`（帶 Access email）→ 回
`{code, deep_link}` → 使用者開連結 → bot 收到 `/start <code>` → 查碼未過期未用
→ upsert `tg_users(chat_id, email)`、標記 code used → 回歡迎訊息。

**每日推播**：cron 每小時 → `runPushTick`：取 `subscribed=1 AND email 非空` 的
列，逐列算本地時 = now + tz_offset；若 `localHour==push_hour` 且 `last_push_on
!=本地日期` → 挑題、`sendMessage`（題幹 + 選項 inline keyboard）、寫
`tg_sessions(kind='daily')`、更新 `last_push_on`。單次 tick 上限 50 人以防爆量。

**作答**：callback `ans:<qid>:<key>` → 查正解 → `batch([review_progress upsert,
insertAttemptOp])` → `answerCallbackQuery` → `editMessageText` 標出對/錯與正解
（＋一個「看詳解」按鈕連回 app 該題）→ 若 session 是 quiz 且有剩題，推下一題。

**小測驗**：`/quiz` → 年份 inline keyboard（`quiz:year:<y>`）→ 題數
（`quiz:count:<n>`）→ 隨機抽該年 N 題，存 `tg_sessions.remaining` → 逐題推進 →
最後回分數與錯題清單（連回 app）。

**指令**：`/start`（綁定/歡迎）、`/today`（立刻來一題）、`/quiz`、`/stats`
（我的正確率，讀 `review_progress`）、`/settings`（開關/時段/年份，inline
toggle）、`/stop`（暫停每日）、`/help`。

## 設定值（config / secrets）

- `config.toml [telegram] bot_username`（前端 deep link 用，經 `__APP_CONFIG__` 注入）
- `wrangler.toml [vars] TG_BOT_USERNAME`（Worker 端 deep link 用）
- Secrets：`wrangler secret put TG_BOT_TOKEN`、`TG_WEBHOOK_SECRET`
- Cron：`crons = ["*/10 19-21 * * *", "0 * * * *"]`；`scheduled()` 依
  `event.cron` 分派（原 roster/note-links 維持原時段，新增每小時推播）。
- Access bypass：`scripts/setup-public-bypass.sh` 增列 `/tg/*`。

## 成本

20 人、每小時 cron、每天每人 ≤ 幾則訊息 —— 全在免費層。cron 的 10ms CPU 上限
只算計算；送訊息是 I/O（`fetch`）放在 `ctx.waitUntil`，不佔 CPU 額度。零 Workers
AI 神經元。

## 測試

`worker/lib/telegram.test.ts`：HTML 跳脫、callback 解析、選項鍵盤組裝、題目
格式化、本地時計算、secret 常數時間比對。Bot API 的 I/O 以 `fetch` 注入樁替換。

## 醒來後的手動步驟（需 BotFather，無法自動化）

1. BotFather `/newbot` → 取得 token；`/setname`、`/setdescription`、
   `/setuserpic`（可選）。
2. `wrangler secret put TG_BOT_TOKEN`、`wrangler secret put TG_WEBHOOK_SECRET`
   （後者自訂一段亂數）。
3. `config.toml` 填 `[telegram] bot_username`；`wrangler.toml [vars]` 填
   `TG_BOT_USERNAME`。
4. 部署 Worker（`crons` 已含每小時）。
5. `scripts/setup-public-bypass.sh` 讓 `/tg/*` 走 Access bypass。
6. `node --experimental-strip-types scripts/setup-telegram.ts`（setWebhook 等）。
7. app 開 Profile → 產生連結 → 開連結完成綁定 → `/today` 驗證。
```
```

## 不做（YAGNI）

- 離線寫入 / 背景同步：Telegram 本身就是伺服器往返，不需要。
- 群組模式：只做私聊 1:1。
- 即時共編 / 通知推送到 bot 以外：維持現有 app 邊界。
- 自訂鍵盤以外的富媒體（圖片題）：先純文字題幹，圖片題連回 app。

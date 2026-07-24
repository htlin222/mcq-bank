# 簡介

## 這是什麼

**mcq-bank** 是一套給小型讀書會（5–50 人）用的選擇題題庫 + 共筆詳解系統。本 fork（**hema-2026**）服務 2026 台灣血液腫瘤次專科考試的內部讀書會（約 20 人），收錄民國 104–114 年、每年 100 題（70 題內科 + 30 題共同）的考古題。

兩種讀書模式：

1. **複習模式** — 一次一題、立即看答案、wiki 式共筆詳解（TipTap rich text + 圖片）、threaded 討論串與 @mention 通知。
2. **全真作答** — 整年 100 題循序作答、計時、成績統計與錯題回顧。

另外還有：**複習班講義**（EmbedPDF 線上閱讀器，個人 highlight / 便利貼 / 頁面錨定筆記、全文搜尋）、**教科書引用「選字問 Wintrobe」**（全站選字 → BM25 跳到教科書最相關頁）、**答案挑戰**（社群對官方答案提出異議、投票升級）、**FSRS 間隔複習**、**個人筆記關聯連結建議**（受控詞表比對、零 AI）、活動 heatmap、**Telegram 出題機器人**（綁定帳號、每日推題、聊天內測驗，計入同一份學習進度）、`/mcq` Claude Code skill（成員在終端機直接查題）。

## 系統架構

```
Cloudflare Access (Zero Trust)          Telegram ──webhook──▶ /tg/*
  ↳ email 白名單 + OTP，注入 Cf-Access-Jwt-Assertion   （Access bypass）
        │                          │                        │
        ▼                          ▼                        ▼
  Pages (React 18 + Vite     Worker (Hono)  ◀──────────────┘
   + TS + Tailwind + TipTap)   /api/* · /img/* · /pdf/* · /tg/*
                                   │            ▲
                                   │     Cron scheduled()：roster 同步、
                                   ▼     筆記 relink drain、Telegram 每日推播
                        D1 (SQLite) · R2 (圖片/PDF/教科書) · Workers AI
```

> `/tg/*` 不在 `/api/*` 下，因此不吃 `authMiddleware`（Telegram 伺服器無法過 Zero Trust），改以 `secret_token` 常數時間比對驗證，並在邊緣設 Access bypass。

| 層 | 技術 |
|---|---|
| 前端 | React 18 + Vite + TypeScript + TailwindCSS + TipTap |
| 後端 | Cloudflare Workers + Hono |
| 資料庫 | Cloudflare D1（SQLite，33 個 migrations，0001–0033） |
| 物件儲存 | Cloudflare R2（圖片、講義 PDF、教科書分冊 PDF，經 Worker proxy） |
| 認證 | Cloudflare Access（Zero Trust，無密碼） |
| AI | Cloudflare Workers AI（免費額度內的輔助功能） |
| 託管 | Cloudflare Pages |

## 關鍵設計決策

### 認證：Zero Trust，App 內零 auth code
不實作密碼 / OAuth / session。Cloudflare Access 在前面驗身分，Worker 只驗 JWT 簽章、取出 email 當作唯一身分。**不要**在 app 層加註冊或改密碼功能——那是錯的層。

### 儲存：TipTap JSON，不是 HTML
`explanations.content_json`、`comments.content_json` 存 ProseMirror JSON。零 XSS（read-only TipTap 渲染，絕不 `dangerouslySetInnerHTML`）、未來可平移到 Yjs CRDT、可做結構化查詢（例如 server-side 抽取 mention node）。

### 共編：Pessimistic lock，刻意不用 CRDT
`explanations` 表有 `editing_by` / `editing_until`，編輯時每 60 秒續鎖、儲存時做 optimistic version check。對 20 人 × 1000 題來說即時共編是 over-engineering；升級路徑保留在 [Roadmap](Roadmap)。

### 圖片：R2 走 Worker proxy，bucket 不公開
上傳走 `POST /api/upload`（驗 size/MIME → UUID key），讀取走 `GET /img/:key`。公開 bucket 會讓 URL 外洩內容，破壞 Zero Trust 邊界。

### 設定：config.toml 單一事實來源
所有 per-fork 識別字（slug、host、資源名、admin email）都在 gitignored 的 `config.toml`。Shell / Node / Python scripts 各有讀取 helper；Worker 讀 `wrangler.toml [vars]`；前端讀 build-time 注入的 `__APP_CONFIG__`。**不要**硬編任何 slug 或資源名。

## 成本

20 人重度使用預期 **$0/月**，全部落在 free tier（Workers / Pages / D1 / R2 / Access 50 seats / AI 10K neurons/日）。任何會超出 free tier 的功能（例如 Durable Objects 需 Workers Paid $5/月）都必須明講，不可默默加上。

## UI 設計語言

Scholarly / editorial，不是 generic SaaS：**全 sans 字體**（Inter + Noto Sans TC；2026-07 起 owner 拿掉了原本的 serif 標題，Tailwind 的 `font-serif` 已 alias 到 sans stack，**不要再引入真 serif**）、ink/cream + 單一 accent（#a8442a 紅墨滴 favicon）、舒適閱讀寬度、行高偏鬆。禁止紫色漸層、glassmorphism、過度陰影。

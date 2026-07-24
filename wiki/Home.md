# mcq-bank（hema-2026）Wiki

國考題庫共筆系統 —— 2026 台灣血液腫瘤次專科考試（hema-2026）instance。
約 1000 題（10 年 × 100 題），提供**複習模式**（單題練習 + 共筆詳解 + 討論串）與**全真作答**（整年計時模擬考），全站跑在 Cloudflare 免費額度上。

- 正式站：<https://hema-2026.hsiehting.com>（Cloudflare Access 白名單 + Email OTP 登入）
- 程式碼：<https://github.com/htlin222/mcq-bank>

## 頁面導覽

| 頁面 | 內容 |
|---|---|
| [簡介 Introduction](Introduction) | 專案目標、系統架構、技術棧、關鍵設計決策 |
| [維運手冊 Maintenance](Maintenance) | 本地開發、部署、資料庫遷移、題庫匯入、名單同步、除錯 |
| [路線圖 Roadmap](Roadmap) | 短中長期方向與已保留的升級路徑 |
| [開發計畫 Plan](Plan) | 進行中 / 已完成的工作項目與設計文件索引 |
| [踩過的坑 Gotchas](Gotchas) | 真實踩過的陷阱：症狀 → 成因 → 修法 |
| [技術債 Tech Debt](Tech-Debt) | 已知的債務清單、風險與償還建議 |

## 快速指令備忘

```bash
pnpm dev                    # 本地 Worker (:8787)
cd frontend && pnpm dev     # 本地前端 (:5173)
./scripts/deploy.sh         # 一鍵部署（idempotent）
pnpm db:pull                # 鏡像 remote D1 → local
```

> 本 wiki 以繁體中文撰寫；程式碼識別字與指令保留原文。

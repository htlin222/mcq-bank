---
name: mcq
version: 0.1.0
description: 取得血液腫瘤考古題單題全文(題幹/選項/答案/共筆詳解)。當使用者輸入 /mcq <年>-<題號>(例如 /mcq 114-001、也接受 114-1)時使用。
---

# mcq — 取單題考古題

使用者會給一個題號,例如 `114-001`(民國年-題號,也接受 `114-1`)。

## 你要做的事

從 repo 根目錄執行:

    python3 .claude/skills/mcq/scripts/get_mcq.py "<題號>"

把 `<題號>` 換成使用者給的值。腳本會自己讀 `.claude/skills/mcq/.env` 的設定、
帶上 `Authorization: Bearer` 與 `X-User-Email` 兩個 header 去打 API,然後印出
格式化的題目(題幹、選項、答案、共筆詳解)。

把腳本輸出**原樣**呈現給使用者即可。若出現錯誤:

- `401` — 金鑰錯誤或未設定 → 提醒檢查 `.env` 的 `MCQ_API_KEY`
- `403` — `MCQ_USER_EMAIL` 不在白名單 → 提醒向管理者確認該 email 已加入
- `404` — 查無此題 → 確認題號格式為 `<年>-<題號>`

## 一次性設定(每位組員各自做一次)

    cp .claude/skills/mcq/.env.example .claude/skills/mcq/.env

然後編輯 `.claude/skills/mcq/.env`,填入三個值:

- `MCQ_API_BASE`   — API host,例如 `https://qa.example.com`
- `MCQ_API_KEY`    — 共用金鑰(向管理者索取,**切勿**提交進 git)
- `MCQ_USER_EMAIL` — 你自己的組員 email

`.env` 已被 `.gitignore` 排除,金鑰不會進版本庫。

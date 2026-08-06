# 新年份題庫匯入（bank-ingest）設計

2026-08-06

## 問題

題庫目前是 104–114 共 11 年、每年 100 題。每年考完要加一屆，流程是：把
`years/<year>/` 底下的 docx/pptx/pdf 手工整成 batch JSON，跑
`batches-to-csv.ts` + `import-questions.ts`，再用 wrangler 打進 D1。

這條路只有 repo 擁有者跑得動——需要 clone、需要 `CLOUDFLARE_API_TOKEN`、需要
記得一整套散在 `years/AGENT_SPEC.md` 裡的解析眉角。管理員換人就斷。

目標：讓**任何 `ADMIN_EMAILS` 裡的人**，從複習模式頁面按一顆按鈕開始，
在不碰 repo、不碰 Cloudflare 憑證的前提下，把一個新年份加進題庫。

## 非目標

- 不做「編輯既有年份」。新年份只進不覆蓋（見〈發布〉的年份衝突規則）。
- 不做網頁端 PDF 解析。解析在本機跑，因為它要 LibreOffice/pdftotext 這類
  Worker 沒有的東西，而且要人來裁決低信心題。
- 不做自動復原。skill 中途死掉就重跑，不建狀態機。

## 總覽

```
複習模式 (YearList)
  └─ [＋ 加入新年份]            僅 isAdminEmail 可見
        ↓
   /review/new-year             五步精靈
        ↓
  Step 1  下載 bank-ingest.skill ────────┐
  Step 2  uv 環境設定 ← 心跳回報          │  離開瀏覽器
  Step 3  跑 skill   ← 進度回報           │
  Step 4  推進暫存區 ←───────────────────┘
  Step 5  逐題審閱 → [確認發布] → questions
```

## 權限模型

三把金鑰，互不相通：

| 金鑰 | 前綴 | 範圍 | 持有者 |
|---|---|---|---|
| 既有 | `mcqk_` | 讀題（Access 之外） | 全體 ~20 人 |
| 新增 | `bnkk_` | 寫暫存區 | 僅 admin |
| — | Access session | 審閱／發布 | admin 瀏覽器內 |

派生沿用 `deriveMcqKey` 的形狀，換 secret 與 scope 字串：

```
bnkk_ + b64url(HMAC-SHA256(BANK_KEY_SECRET, `${email}:bank:${version}`))
```

獨立的 `users.bank_key_version`，獨立 rotate。`GET /api/me/bank-skill` 在非
admin 時回 403——不只是把按鈕藏起來。

**關鍵性質：`bnkk_` 只能寫暫存區，不能發布。** 就算 admin 的筆電被拿走，
攻擊者最多塞一批髒資料進 `import_staging`，學員完全看不到；真正進
`questions` 那一步必須在 Access 認證過的瀏覽器裡按下去。特權 skill 的實際
爆炸半徑因此接近零。

`isAdminEmail` 讀 `wrangler.toml [vars] ADMIN_EMAILS`，所以「未來多一個人」
＝改一行 vars 重新 deploy，不需要動程式碼。

## 精靈

### Step 1 — 取得工具

`GET /api/me/bank-skill` 現打包 zip（同 `mcq-skill` 的 `zipSync` 路徑），
內含 `SKILL.md`、`pyproject.toml`、`scripts/*.py`，加上烘好的 `.env`：

```
BANK_API_BASE=https://…
BANK_API_KEY=bnkk_…
BANK_USER_EMAIL=…
```

旁邊顯示金鑰版本與「重新產生」鈕（rotate 後舊檔失效）。

### Step 2 — 本機環境（有心跳）

```bash
unzip bank-ingest.skill -d ~/.claude/skills/bank-ingest
cd ~/.claude/skills/bank-ingest && uv sync
uv run python scripts/doctor.py
```

`doctor.py` 檢查相依套件可 import，然後打一支不帶年份的
`POST /api/admin/import-year/heartbeat`（`bnkk_` 認證）。Worker 只更新一欄
`users.bank_last_seen_at`。

心跳的價值不在「裝好了沒」，而在**它同時驗證了金鑰有效與網路可達**。最可能
的失敗是 `.env` 裡的金鑰已被 rotate；沒有心跳的話這個錯誤要拖到 Step 4 推送
時才炸，使用者已經白跑整個解析。有了心跳，Step 2 就顯示「金鑰已失效，請重新
下載」。

### Step 3 — 跑 skill（有進度）

素材佈局：

```
~/bank-115/
  內科.pdf
  共同.pdf
```

在 Claude Code 裡 `/bank-ingest 115 ~/bank-115`。skill 在每個階段打
`POST /api/admin/import-year/progress`，Worker 更新 `import_jobs.stage`：

```
ready → parsing → parsed → explaining → pushed
```

頁面顯示 `解析中 · 共同.pdf · 已抽出 43/100`。

skill 中途死掉，`stage` 停在原地、`updated_at` 變舊。頁面顯示「上次回報 8
分鐘前，可能已中斷」並附重跑指令，僅此而已。

### Step 4 — 等待推送

輪詢 `GET /api/admin/import-year/status`。推完出現卡片：
`115 年 · 100 題 · 3 題待確認`。

### Step 5 — 審閱與發布

逐題預覽，低信心與缺答案的排在最前面並標紅。確認後
`POST /api/admin/import-year/:job/publish`。

### 狀態存哪

精靈進度不存前端，靠「暫存區有沒有這個年份」推導。重新整理、換裝置都會回到
正確的一步。符合 CLAUDE.md 的「別用 localStorage 存 app state」。

## 答案偵測

### 實測發現：答案是白色的「字」，不是白色的方塊

對 `reference/official-exam-pdfs/114…答案顯示版.pdf` 第一頁做 span 分析：

```
'B' color=#ffffff  x=551.3  font=BookAntiqua   ← 隱藏層(白字白底)
'B' color=#d90000  x=551.3  font=Helvetica     ← 答案顯示版才有的紅字覆蓋
'D' color=#ffffff  x=551.3  font=BookAntiqua
'D' color=#d90000  x=551.3  font=Helvetica
```

答案欄（x≈551）永遠有一個 `#ffffff` 的單字元 span；「答案顯示版」只是在同一
位置再疊一個紅字。這代表**官方的「題目版」PDF 本身就含有答案**，只是肉眼看
不到——不需要另外拿到答案顯示版。

`pdftotext -layout` 會把兩層都吐出來，所以純文字管線會看到答案出現兩次；用
span 顏色判讀才拿得到乾淨的單一來源。

### 偵測鏈

逐級降信心，命中即停：

| # | 規則 | conf |
|---|---|---|
| 1 | 答案欄白字 span | 1.0 |
| 2 | 答案欄可見字（顯示版紅字／一般黑字） | 1.0 |
| 3 | `(?:答案|Ans|答)[:：\s]*([A-E])\b` | 0.9 |
| 4 | 卷末答案表對題號 | 0.85 |
| 5 | 詳解敘述推斷 | 0.5 |
| 6 | 全數落空 → `answer=""` | 0.0 |

答案欄的 x 座標**不寫死**，由「整欄都是單一 A–E 字母、每題一個」自動推導，
換版型不會壞。推導失敗就跳過規則 1–2、退到 3–6。

規則 1 只在 114 世代的官方 PDF 上驗證過。其餘格式（docx/pptx／舊年份詳解檔）
沿用 `years/AGENT_SPEC.md` 既有的 playbook，那份規格已經在 104–114 全部跑過。

## 詳解

skill 跑到一半問三選一：

```
? 詳解要怎麼處理?
  > 1. 只抽取來源詳解 (預設)
    2. 抽取 + AI 補缺
    3. 不匯入詳解
```

抽取出的 markdown **在本機轉成 TipTap JSON**（沿用 `seed-explanations.py`
的轉換邏輯），推上來的就是 `explanations.content_json` 要的形狀。Worker 端
只驗結構，不必新寫一份 TS markdown parser。

選 2 時只針對來源沒有詳解的題呼叫 AI，並在 `source` 欄標明來源以便日後辨識。

## 資料模型

```sql
CREATE TABLE import_jobs (
  id             TEXT PRIMARY KEY,
  year           INTEGER NOT NULL,
  created_by     TEXT NOT NULL,
  stage          TEXT NOT NULL,   -- ready|parsing|parsed|explaining|pushed|published|discarded
  detail         TEXT,            -- 自由文字,給進度卡片顯示
  question_count INTEGER NOT NULL DEFAULT 0,
  needs_review   INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

-- 同一年份同時只能有一個進行中的 job
CREATE UNIQUE INDEX idx_import_jobs_live ON import_jobs(year)
  WHERE stage NOT IN ('published','discarded');

CREATE TABLE import_staging (
  job_id  TEXT NOT NULL REFERENCES import_jobs(id) ON DELETE CASCADE,
  number  INTEGER NOT NULL,
  payload TEXT NOT NULL,          -- 單題物件,形狀同 years/*/batches/*.json
  PRIMARY KEY (job_id, number)
);
```

`users` 加兩欄：`bank_key_version INTEGER NOT NULL DEFAULT 1`、
`bank_last_seen_at INTEGER`。

## 發布

`POST /api/admin/import-year/:job/publish`（Access + admin，不吃 `bnkk_`）。

前置檢查，任一不過就整批拒絕：

1. 該年份在 `questions` **完全不存在**。已存在就拒絕，要求先 discard。
   ——這條同時堵掉記憶裡那個「re-import 的 upsert 無條件覆蓋 `answer`，把社群
   升級過的答案蓋回 CSV 且不留痕」的坑：只 INSERT、不 UPSERT，就不可能覆蓋。
2. 題數等於 `config.toml [groups].list` 的總和。
3. 每題 `answer` 非空且是 `options` 的鍵。
4. `number` 落在該 group 的配額區間（沿用 `import-questions.ts` 的
   `buildGroupSpec()`）。

通過後在單一 `DB.batch()` 裡寫 `questions` + `question_tags` +
`explanations`，然後把 job 標成 `published`。

## Service Worker

`heartbeat` / `progress` / `status` 三支**必須排除**在
`frontend/src/lib/sw-guards.ts` 的 `CACHEABLE_API` 之外，跟 `/api/me`、
notifications 同一類。快取一個「12 秒前」會讓整個心跳機制變成謊話。

## 驗證

- 純函式進 unit test：`bnkk_` 派生／驗證、答案欄推導、staging 前置檢查、
  markdown→TipTap。
- `/review/new-year` 依 CLAUDE.md 規定補 e2e fixture，過 WebKit smoke。
- `sw-guards` 新增排除項的測試。

## 檔案

```
migrations/00NN_bank_ingest.sql
worker/lib/bank-key.ts              # bnkk_ 派生 + middleware
worker/lib/import-validate.ts       # 前置檢查(純函式)
worker/routes/admin-import.ts       # heartbeat/progress/push/status/publish/discard
worker/routes/me.ts                 # + bank-key, bank-skill 下載
scripts/gen-bank-bundle.mjs         # skill → worker/generated/bank-bundle.ts
.claude/skills/bank-ingest/
  SKILL.md
  pyproject.toml
  scripts/{doctor,ingest,parse,answers,explain,push}.py
frontend/src/routes/NewYear.tsx     # 五步精靈
frontend/src/routes/YearList.tsx    # + 加入新年份 按鈕
frontend/src/lib/sw-guards.ts       # 排除新端點
```

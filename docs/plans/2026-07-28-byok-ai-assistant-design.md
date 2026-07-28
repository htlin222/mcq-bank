# BYOK AI 助手 + 統一選字工具列

2026-07-28

## 目標

讓使用者帶自己的 Groq 金鑰,在任何一段選取的文字上跑自訂提示詞。順帶把
目前各自為政的兩個選字浮層(螢光標記、查參考資料)收成同一列工具列。

## 金鑰流向

```
瀏覽器                                    Cloudflare
┌────────────────────────────┐           ┌───────────────────────┐
│ localStorage               │           │ Worker /api/ai/prompts│
│   byok:groq:key   ← 只在這 │           │        ↓              │
│   byok:groq:model          │           │ D1 ai_prompts (雲端)  │
└──────────┬─────────────────┘           └───────────────────────┘
           │ Authorization: Bearer gsk_…
           ▼
   https://api.groq.com/openai/v1/chat/completions  (SSE 串流)
```

金鑰**絕不**經過我們的 Worker、**絕不**進 D1。只從 localStorage 讀出來,直接
放進送往 Groq 的 header。代價是換裝置要重設、清瀏覽器資料就沒了 —— UI 上
明講,不假裝它會同步。

雲端只存 prompt,不存金鑰,兩者解耦:沒設金鑰的人照樣看得到自己的 prompt
列表,只是按下去會引導去設定。

`api.groq.com` 已實測允許瀏覽器 CORS(`access-control-allow-origin: *`,且
`access-control-allow-headers` 含 `authorization`),所以直連可行。

### CSP

`frontend/public/_headers` 的 `connect-src` 要加 `https://api.groq.com`。這是
唯一放寬,範圍明確。**不採用** Worker 當 proxy 的替代方案 —— 那會讓金鑰經過
伺服器,與「只存本機」的整個前提相違背。

### 健康檢查

`GET https://api.groq.com/openai/v1/models`。一次呼叫同時驗證金鑰有效 + 拉回
該帳號可用模型清單餵給下拉選單。免費、不耗 token。

## 資料模型

`migrations/0034_ai_prompts.sql` —— 只存使用者自訂的。四個預設留在前端程式
碼,不佔 DB、不需要 seed、也就沒有「還原預設」這種狀態要維護。

```sql
CREATE TABLE ai_prompts (
  id         TEXT PRIMARY KEY,
  user_email TEXT NOT NULL,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_ai_prompts_user ON ai_prompts(user_email, sort_order, created_at);
```

## API

`worker/routes/ai-prompts.ts`,掛在 `/api/ai/prompts`。獨立於 `ai.ts` ——
後者是 Workers AI 的伺服器端推論,和 BYOK 設定是不同的事。

| Method | Path | 說明 |
|---|---|---|
| GET | `/api/ai/prompts` | 列出本人的自訂 prompt |
| POST | `/api/ai/prompts` | 新增(上限 20 筆,title ≤ 30 字、body ≤ 2000 字) |
| PUT | `/api/ai/prompts/:id` | 改標題/內容/排序 |
| DELETE | `/api/ai/prompts/:id` | 刪除 |

擁有者一律取 `c.var.email`,`WHERE user_email = ?` 綁在每一句 SQL 上。

**不加進 SW 的 `CACHEABLE_API`** —— 可寫資料,快取只會讓兩台裝置打架。

## 提示詞

變數 `{{selection}}`(選取文字)與 `{{context}}`(所在段落),送出前在前端替換。
body 沒寫任何變數時,自動把選取文字附在結尾 —— 免得使用者寫了 prompt 卻忘記
插變數,結果 AI 收到一句空話。

四個內建預設在 `frontend/src/lib/aiPrompts.ts`,id 前綴 `builtin:`:

- **ELI5** —— 當作對完全外行的人解釋,用比喻,不要專有名詞堆疊
- **助記** —— 中英文皆可的口訣/諧音/首字母記憶法
- **大綱** —— 階層式條列,標出上位概念與從屬關係
- **必考重點** —— 以台灣血液腫瘤專科考試出題者的角度,列出最可能被考的點與陷阱

## 統一選字工具列

新元件 `frontend/src/components/SelectionToolbar.tsx`,取代
`TextbookLookupPopup` 的外殼與 `AnnotatableContent` 內嵌的小 popup。今天選字
落在詳解裡時兩個浮層會同時冒出來,這就是要修掉的東西。

```
┌─────────────────────────────────────────────┐
│  🖊 螢光標記  │  📖 查參考資料  │  ✨ AI    │
├─────────────────────────────────────────────┤
│  (展開區:參考資料結果 或 AI prompt 選單/串流)│
└─────────────────────────────────────────────┘
```

一個外框、一組樣式,展開區在同一張卡片裡往下長,不再是第二個浮層。

動作按情境亮:

| 動作 | 出現條件 |
|---|---|
| 螢光標記 | 選取落在某個 `AnnotatableContent` 內、且非防劇透模式 |
| 清除標記 | 點擊既有 `<mark>`(無選取,見下) |
| 查參考資料 | 選取 ≥3 字且含實詞(維持現行 `hasMeaningfulContent`) |
| AI | 永遠(未設金鑰時點下去 → 引導到 Profile) |

### MIN_LEN 從 3 降到 1

全站 `useTextSelection` 目前是 `MIN_LEN = 3`,但 `AnnotatableContent` 今天
≥1 字就能標記。中文兩字詞(「貧血」「溶血」)非常常見,若沿用 3 就等於偷偷
砍掉兩字詞的畫記能力。所以門檻降到 1,改成**逐動作 gating** —— 工具列 1 字
就出現,「查參考資料」在 <3 字時不顯示。

### AnnotationRegistry

新 context。每個 `AnnotatableContent` 掛載時註冊
`{ dom, cloze, applyHighlight, clearHighlight }`;工具列拿到選取後反查 anchor
落在哪個註冊的 `dom` 裡,有找到才亮「螢光標記」。這樣工具列只需要一份、掛在
App 層,不用每個 editor 各養一個浮層。

點既有 `<mark>` 的「清除標記」路徑沒有選取,是另一種觸發:
`AnnotatableContent` 偵測到 mark-click 後,主動推一個
`{ kind: 'mark', rect, editorId, from, to }` 給 registry,工具列以同一張卡片
呈現,只是第一顆按鈕換成「✕ 清除標記」,旁邊依舊可以查參考資料 / 問 AI。

## AI 呼叫流程

點「✨ AI」→ 同一張卡片往下展開成 prompt 清單(四個內建 + 自訂)→ 點其中
一個 → 換成串流結果區。

送出的訊息:

```
system: 你是台灣血液腫瘤專科考試的讀書夥伴。用繁體中文(台灣用語)回答,
        專有名詞保留英文原文。簡潔,不要客套開場白。
user:   <prompt.body,已替換 {{selection}} / {{context}}>
```

`{{context}}` 取選取所在區塊的文字:從 range 的 `commonAncestorContainer`
往上走到最近的 block 元素(`p / li / td / h1-h6` 等)取 `textContent`,
上限 800 字。取不到就退回只給 `{{selection}}`。

串流:`stream: true` + 手解 SSE(`data: {...}` / `data: [DONE]`),逐塊 append
進 state,用既有 `markdownToHtml` 渲染。附「停止」(`AbortController`)與
「複製」。

## 存進該題筆記

只在題目頁(`useParams` 拿得到 qid)才顯示。流程:`markdownToHtml(回覆)` →
`generateJSON`(`@tiptap/html`,配 `buildExtensions({readOnly:true})` 的同一組
extension)→ 取現有 `content_json`,尾端 append 一個 `## <prompt 標題>` heading
+ 內容 → `PUT /api/questions/:id/note`。

**append,絕不覆寫。** 成功後 toast「已加到筆記」。

`@tiptap/html` 目前不在 dependencies,要加;與已裝的 `@tiptap/core` 同版號。

## 錯誤處理

全部顯示在展開區,不用 alert。

| 狀況 | 訊息 |
|---|---|
| 沒設金鑰 | 「尚未設定 Groq 金鑰」+ 直達 Profile 的連結 |
| 401 | 「金鑰無效,請到設定重新輸入」 |
| 429 | 「Groq 額度用盡或請求過快,稍後再試」 |
| 400 / 404 model | 「模型 `xxx` 不可用,請到設定重選」 |
| fetch reject | 「連不上 Groq(可能被瀏覽器或網路阻擋)」 |

## 測試

- `aiPrompts.test.ts` —— 變數替換:有 `{{selection}}`、無變數自動附加、
  `{{context}}` 缺值時的降級
- `groqStream.test.ts` —— SSE 解析:切半的 chunk、`[DONE]`、keep-alive 空行
- `selectionActions.test.ts` —— 動作 gating:1 字只給螢光標記、3 字才給
  查參考資料、不在 registry 內不給螢光標記

## 不做(YAGNI)

多輪追問、結果快取、用量統計、金鑰跨裝置同步。

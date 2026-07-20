# App 內匯出(Markdown / CSV / Anki) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 讓讀書會成員在 App 內自選範圍(收藏資料夾 / 錯題 / 某一年 / 搜尋結果 / 某次測驗),把「題目 + 官方共筆詳解 + 我的個人筆記 + 我的畫記」匯出成可攜檔案 —— 離線讀(Markdown)或匯進自己的 Anki(CSV)。

**Architecture:** 一支 `POST /api/export` 端點。伺服器端流程固定三段:`resolveScope()`(範圍 → question id 清單,全部綁 `c.var.email`)→ D1 撈題目/詳解/筆記/畫記 → `renderExport()`(純函式,組 Markdown 或 CSV)。核心是一個可測的 **TipTap doc → Markdown / HTML / plain text renderer**,同時取代目前散落在 `scripts/build-anki.py:592` 與 `worker/lib/cloze.ts:22` 的兩份半套實作。圖片一律走既有 worker proxy `/img/<key>`,R2 bucket 不動。

**Tech Stack:** Cloudflare Workers (Hono) + D1。無新增綁定、無新增付費服務。前端 React 18 + Vite + TipTap。測試 `node --test`(`node:test` + `node:assert/strict`),沿用 `package.json` 的 `"test": "node --test 'worker/**/*.test.ts'"`。

---

## 現況(以 file:line 為憑)

**既有的離線 apkg 流程 —— `scripts/build-anki.py`(750 行)**

- 用 `wrangler d1 execute --json` 逐年撈題(`scripts/build-anki.py:539-572`,`questions LEFT JOIN explanations`)。**沒有 personal_notes、沒有 highlights** —— 這正是「帶不走自己的筆記」的根因。入口是 `package.json` 的 `anki:build` / `anki:build:mine`,產物 `anki-deck/血專-1xx年.apkg`(最大 12.8 MB,gitignored),使用者無法自選範圍。
- 卡片組法(可直接沿用的模板語彙):Front = `.qid` + `.stem` + `<ul class="options">`;Back = `.answer` 正解 + `.expl` 詳解 HTML(`scripts/build-anki.py:648-668`)。
- **TipTap → HTML 的既有實作在 `scripts/build-anki.py:592-635`**:涵蓋 doc / text(bold, italic, link)/ paragraph / heading / bulletList / orderedList / listItem / blockquote / hardBreak / image;**未涵蓋 table、codeBlock、highlight、mention、questionRef**,未知節點靜默降級成 children(`:635`)。新的 TS renderer 要**移植這份對照表並補齊缺口**,不要重新發明。
- 圖片:`/img/<key>` 經 `local_path()` 對映回 repo 的 `years/<yy>/images/`(`:579-586`)再打包進 apkg media(`:680-688`),對映不到就靜默略過(`:589, :630`)。→ 這條路徑**只在有 repo 原始檔的本機成立**,worker 端無法重用。
- ⚠️ 命名衝突:`frontend/src/routes/AnkiDeck.tsx` 是**站內 FSRS 複習頁**(`/api/review/anki/decks`,`worker/routes/review.ts:339`),與 apkg 無關,不要改到它。

**資料來源**

| 內容 | 來源 | 位置 | 私有? |
|---|---|---|---|
| stem / options_json / answer / group | `questions` | `worker/routes/questions.ts:92` | 共享 |
| 共筆詳解 `content_json`(TipTap) | `explanations` | `worker/routes/explanations.ts:47`、`questions.ts:100` | 共享 |
| tags | `question_tags` | `worker/routes/questions.ts:106` | 共享 |
| 個人筆記 `content_json`(TipTap) | `personal_notes` | `worker/routes/notes.ts:15-24`、`questions.ts:123` | **私有** |
| 畫記 `doc_json`(含 `highlight` mark) | `highlights` | `worker/routes/highlights.ts:13-38` | **私有** |

畫記的 `store_key` 兩種前綴:`anno:exp:<qid>`(詳解上的畫記,`frontend/src/routes/Question.tsx:934`)與 `anno:note:<qid>:<hash>`(個人筆記上的,`frontend/src/lib/noteHighlights.ts:23`)。`worker/routes/highlights.ts:15` 已支援 `?prefix=`,但**沒有依 question_id 查的能力** —— 匯出要在 worker 內以 `store_key LIKE 'anno:%:<qid>%'` 過濾,或全撈後在記憶體比對(1 人畫記量小,後者夠用)。

**範圍入口(既有 API,全部已綁 email)**

- 收藏資料夾 `GET /api/bookmarks?folder=<id>|null` / `?source=notes`(`worker/routes/bookmarks.ts:12-56`),資料夾清單 `worker/routes/folders.ts:8`。前端 `frontend/src/routes/Bookmarks.tsx:30`,分類常數 `ALL / UNCATEGORIZED / NOTES / HIGHLIGHTS`(`:25-28`)——**匯出最自然的入口就在這個側欄**。
- 錯題 `GET /api/review/wrong`(`worker/routes/review.ts:594`,`times_seen>0 AND 正確率<100%`,支援 year/group/tags);某一年 `GET /api/questions?year=`(`questions.ts:17`);搜尋 `GET /api/search?q&year&group&tags&answered&sort`(`search.ts:22-31`);測驗結果 `GET /api/exam/:sid`(`exam.ts:304`)。

**前端渲染既有做法**

`frontend/src/components/ReadOnlyContent.tsx:5` 用 `useEditor({ editable:false })` + `buildExtensions({readOnly:true})` 渲染。擴充清單在 `frontend/src/lib/tiptap-extensions.ts:14-50`:StarterKit(heading 1-3)、Highlight、Table/TableRow/TableHeader/TableCell、Image(`allowBase64:false`)、Link、Mention(`renderText` → `@label`,`:40`)、QuestionRef(`frontend/src/lib/question-ref.ts:7`,inline atom,`renderText` → `@<qid>`)。**這份清單就是 renderer 必須涵蓋的節點全集。**

**其它:** `worker/routes/images.ts:7-28` 的 `/img/:key{.+}` = 路徑穿越防護 + R2 get + `private, max-age=86400`(Access 已在上游驗過身分);migrations 最後一號 `migrations/0022_highlights.sql`;前端 `frontend/src/lib/api.ts:43-53` 的 `api` 只有 JSON 方法(`request()` 一律 `JSON.parse`,`:37`),**沒有下載 blob 的能力**,要補。

---

## 格式決策

| 格式 | 產生位置 | 實作成本 | 離線可讀 | 帶得走筆記 | 進得了 Anki | 圖片 |
|---|---|---|---|---|---|---|
| **Markdown 單檔** | worker(字串拼接) | 低 | ✅ | ✅ | ➖ | 連結;可選 base64 內嵌 |
| **CSV(Anki 匯入)** | worker(字串拼接) | 低 | ➖ | ✅ | ✅ 原生支援 | 只能絕對 URL(Anki 不抓遠端圖) |
| HTML 單檔 | worker | 低(共用 renderer) | ✅ | ✅ | ➖ | 可 base64 內嵌 |
| ZIP(md + images/) | **瀏覽器**(fflate) | 中 | ✅ 含圖 | ✅ | ➖ | 真正打包 |
| `.apkg` | worker 需組 SQLite + zip | **高** | ✅ | ✅ | ✅ | 需 media 打包 |
| PDF | worker 需字型 + 排版引擎 | **高** | ✅ | ✅ | ➖ | 需嵌入 |

**判斷理由:**
1. `.apkg` 要在 Worker 內**手刻 SQLite 檔案格式 + zip + media map**(genanki 在 Python 端做的事),沒有可用的 Workers-compatible 套件;還要處理 note type id 的老問題(`scripts/build-anki.py:20-22` 已寫得很清楚:任何可散布檔案都無法對上每個人的 Basic id)。投入產出比極差 —— 而 **Anki 原生就吃 CSV**,`#notetype:` / `#deck:` / `#html:true` 標頭指令就能達到 95% 的效果。
2. PDF 同理:Worker 內沒有中文字型(CJK 字型檔本身就 5-15 MB),排版引擎更不可能塞進 1 MB script 上限。**替代方案:HTML 匯出 + 瀏覽器列印成 PDF**,零成本、字型由系統提供。
3. Markdown 是唯一「人類可讀 + 版本控制友善 + 任何編輯器可開 + 可再轉任何格式」的選項,且產生成本最低。

**第一版(Task 1-4):Markdown + CSV,worker 端產生,圖片保留絕對 URL。第二版(Task 5):圖片 base64 內嵌(小範圍限額)+ HTML 格式(供列印成 PDF)。第三版(選配,Task 6):瀏覽器端 ZIP 打包。**

---

## 非目標

- ❌ Worker 內產生 `.apkg` 或 PDF(理由如上;`scripts/build-anki.py` 的離線流程**保留不動**,仍是全年份完整 deck 的來源)。
- ❌ 匯出他人的個人筆記 / 畫記 / 未公開內容。
- ❌ 匯出留言討論串(`comments`)—— 第一版不含,語意上屬於「站上互動」而非「隨身讀物」。
- ❌ 排程 / 非同步 / email 寄送匯出檔。
- ❌ 匯入(import)—— 單向。

---

## 跨切面約定

- 授權:**所有** scope 解析與私有內容查詢一律以 `c.var.email` 為 where 條件,不接受 body 傳入的 email。
- R2 bucket 維持私有(CLAUDE.md);圖片一律 `/img/<key>`,base64 內嵌時由 worker 用 `c.env.R2.get()` 讀,絕不改 bucket 權限。
- 純函式優先抽出(`worker/lib/*.ts`),測試檔同目錄 `*.test.ts`,先寫失敗測試。
- 不需要 migration。若日後要加匯出稽核表,用編號 **0030**,並在實作前重新確認 `ls migrations | tail -1`(撰寫本計畫時最後一號是 `0022_highlights.sql`)。
- UI 沿用 scholarly/editorial:ink/cream + accent `#a8442a`(`frontend/tailwind.config.js:21`)。
- 每個 task 獨立 commit。

**Free tier 額度估算(實作前用 `wrangler tail` 複核)**
- Worker CPU:free plan 每次 invocation 10 ms **CPU**(D1/R2 的 I/O 等待不計)。純字串拼接 200 題 ≈ 600 KB 輸出,實測應在數 ms 內;超過就會被砍。→ 硬上限 `MAX_QUESTIONS = 200`,超過回 413 要求縮小範圍。
- 回應大小:200 題 × 中文 ~1000 字 × 3 bytes ≈ 600 KB;含選項與筆記估 1 MB。純文字回應無壓力。
- base64 內嵌圖片:單張 200 KB → 267 KB,是**體積與 CPU 的主要風險**。硬上限 20 張 / 總計 4 MB,並行度 ≤ 6(Workers 同時 I/O 連線限制),超過就退回連結模式並在檔頭註記。
- D1 讀取:一次匯出 ≈ 5 個 query(questions / explanations / tags / notes / highlights),全部 `WHERE id IN (…)` 批次,不做 N+1。

---

## Task 1.1: TipTap renderer 純函式(TDD,本計畫核心)

**Files:** Create `worker/lib/tiptap-render.ts` / Test `worker/lib/tiptap-render.test.ts`

對照表直接移植 `scripts/build-anki.py:592-635`,補齊 `frontend/src/lib/tiptap-extensions.ts:14-50` 有而 Python 版沒有的節點。

**Step 1 — 先寫失敗測試** `worker/lib/tiptap-render.test.ts`,每種節點至少一個案例:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { docToMarkdown, docToHtml, docToPlainText } from "./tiptap-render.ts";

const doc = (...content: any[]) => ({ type: "doc", content });
const p = (...c: any[]) => ({ type: "paragraph", content: c });
const t = (text: string, marks?: any[]) => ({ type: "text", text, ...(marks && { marks }) });

test("空 doc / null 輸入 → 空字串", () => {
  assert.equal(docToMarkdown({ type: "doc", content: [] }), "");
  assert.equal(docToMarkdown(null), "");
});

test("heading 依 level 轉 # / text marks", () => {
  assert.equal(docToMarkdown(doc({ type: "heading", attrs: { level: 2 }, content: [t("機轉")] })), "## 機轉");
  assert.equal(docToMarkdown(doc(p(t("A", [{ type: "bold" }])))), "**A**");
  assert.equal(docToMarkdown(doc(p(t("D", [{ type: "link", attrs: { href: "https://x.test" } }])))), "[D](https://x.test)");
  // highlight = 使用者的畫記,用 ==…==(Obsidian / Anki 皆通)保留
  assert.equal(docToMarkdown(doc(p(t("E", [{ type: "highlight" }])))), "==E==");
});

test("巢狀 list 縮排正確", () => {
  const nested = doc({ type: "bulletList", content: [{ type: "listItem", content: [
    p(t("外層")),
    { type: "bulletList", content: [{ type: "listItem", content: [p(t("內層"))] }] },
  ] }] });
  assert.equal(docToMarkdown(nested), "- 外層\n  - 內層");
});

test("未知節點類型:降級遞迴 children,不丟例外、不吐 [object Object]", () => {
  assert.equal(docToMarkdown(doc({ type: "someFutureNode", content: [p(t("仍看得到"))] })), "仍看得到");
  assert.equal(docToMarkdown(doc({ type: "atomFuture" })), "");
});
// 其餘各一案,寫法同上:orderedList 編號遞增 / blockquote / codeBlock 帶 language /
// hardBreak / horizontalRule / inline code / table → GFM pipe table(首列為表頭)/
// image → ![](/img/k) 且 src 經 sanitize(拒 javascript:)/ mention → @label(無 label 退回 id)/
// questionRef → @114-001(md 版帶站內連結)/ docToHtml 跳脫 & < > 與屬性引號 /
// docToPlainText 剝除所有標記、區塊間換行
```

**Step 2:** `node --test worker/lib/tiptap-render.test.ts` → FAIL。

**Step 3 — 實作** `worker/lib/tiptap-render.ts`。三個 exported 純函式共用一個 walker:

```ts
export type RenderOpts = {
  imageSrc?: (src: string) => string | null;  // 改寫圖片 src(base64/補 origin);null = 略過該圖
  questionRefBase?: string;                   // questionRef 連結前綴,如 "https://host/q/"
};
export function docToMarkdown(doc: unknown, opts?: RenderOpts): string;
export function docToHtml(doc: unknown, opts?: RenderOpts): string;
export function docToPlainText(doc: unknown): string;
```

要點:未知 type **遞迴 children 後回傳**(與 `scripts/build-anki.py:635` 同語意);`null`/非物件輸入回 `""`;list 縮排用深度 × 2 空格;table 只在有 `tableRow` 時輸出,首列當表頭;image src 走 `safeImageSrc()`(已存在於 `worker/lib/note-doc.ts:249`,直接 import,不要複製)。

**Step 4:** PASS + `pnpm exec tsc --noEmit` → `pnpm test` → `git commit -m "feat(export): pure TipTap doc renderer (markdown/html/text)"`

---

## Task 1.2: 單題 → Markdown 區塊組裝(TDD)

**Files:** Create `worker/lib/export-doc.ts` / Test `worker/lib/export-doc.test.ts`

**Step 1 — 失敗測試:** `renderQuestionMarkdown(item, opts)`,`item` 形狀 `ExportItem = { id, year, number, group, stem, options: {key,text}[], answer, tags: string[], explanation: TipTap doc | null, note: TipTap doc | null(只會是自己的), highlights: string[](已抽成純文字的畫記片段) }`。

測項:(a) 標題為 `## 114-001`,正解列出 key + 該選項文字(對照 `scripts/build-anki.py:661-663`);(b) 詳解為 null 時整個「### 詳解」小節不出現;(c) 筆記為 null 時「### 我的筆記」不出現;(d) 畫記為空陣列時「### 我的畫記」不出現;(e) tags 空時不輸出 tag 行;(f) `renderExportMarkdown(items, meta)` 產出檔頭(標題、匯出時間、範圍描述、**隱私提示**、題數)後接各題,題間 `\n\n---\n\n`。

**Step 2:** FAIL → **Step 3** 實作(呼叫 Task 1.1 的 `docToMarkdown`)→ **Step 4** PASS。

檔頭固定含這行,把隱私要求落地成可見文字:`> 本檔含 <email> 的私人筆記與畫記,僅供本人使用,請勿轉傳。`

**Step 5:** `pnpm test` → `git commit -m "feat(export): markdown document assembly for questions"`

---

## Task 2.1: 範圍解析純函式 + SQL(TDD)

**Files:** Create `worker/lib/export-scope.ts` / Test `worker/lib/export-scope.test.ts`

**統一的「選擇範圍」語彙**(前後端共用的 discriminated union):

```ts
export type ExportScope =
  | { kind: "folder"; folder_id: string | null }   // null = 未分類
  | { kind: "bookmarks" }                          // 全部收藏
  | { kind: "notes" }                              // 有個人筆記的題
  | { kind: "highlights" }                         // 有畫記的題
  | { kind: "wrong"; year?: number; group?: string; tags?: string[] }
  | { kind: "year"; year: number }
  | { kind: "exam"; session_id: string; only_wrong?: boolean }
  | { kind: "ids"; ids: string[] };                // 搜尋結果 / 自訂測驗結果
```

- **Step 1 — 失敗測試(不碰 D1,純邏輯):** `parseScope(body)` 每種 kind 回正確物件,缺欄位 / 未知 kind → `{ error }`;`scopeLabel(scope)` 回中文範圍描述(進檔頭與檔名),如 `收藏・心臟`、`錯題(113 年)`、`搜尋結果`;`scopeSql(scope, email)` 回 `{ sql, params }`,**每一種 kind 各一個案例斷言 `params[0] === email`**(防止未來新增 kind 時漏綁);`ids` 上限 200,超過截斷並回 `truncated: true`。
- **Step 2:** `node --test worker/lib/export-scope.test.ts` → FAIL。
- **Step 3 — 實作:** where 條件沿用既有查詢 —— `folder`/`bookmarks` → `bookmark_items`(`worker/routes/bookmarks.ts:44-52`);`notes` → `personal_notes`(`:20-28`);`highlights` → `highlights` 表 + 從 `store_key` 反解 qid;`wrong` → `review_progress` 條件(`worker/routes/review.ts:600-602`);`exam` → `exam_sessions` join `answer_history`,**where `user_email = ?`**。搜尋結果刻意**不**複製 `worker/routes/search.ts:22` 的 FTS SQL,改由前端把目前結果的 id 傳成 `ids` scope —— 這個取捨要寫進 `export-scope.ts` 的註解。
- **Step 4:** PASS → `pnpm test` → `git commit -m "feat(export): scope vocabulary + per-user scoped SQL"`

---

## Task 2.2: `/api/export` 端點(Markdown)

**Files:** Create `worker/routes/export.ts` / Modify `worker/index.ts`(於 `app.route('/api/state', stateRoutes)`(`:103`)之後加 `app.route('/api/export', exportRoutes)`)

- **Step 1:** `POST /api/export/preview` — body `{ scope }`,回 `{ count, ids, label, truncated }`。UI 靠它在按下匯出前顯示「將匯出 47 題」。
- **Step 2:** `POST /api/export` — body `{ scope, format: "md" | "csv", include: { explanation?, note?, highlights? } }`(預設全 true):

```ts
const ids = await resolveIds(c.env.DB, scope, c.var.email);
if (ids.length === 0) return c.json({ error: "empty scope" }, 400);
if (ids.length > MAX_QUESTIONS)
  return c.json({ error: "too many", count: ids.length, max: MAX_QUESTIONS }, 413);
const items = await loadItems(c.env.DB, ids, c.var.email, include);
const body = renderExportMarkdown(items, { label: scopeLabel(scope), email: c.var.email, now: Date.now() });
return new Response(body, { headers: {
  "Content-Type": "text/markdown; charset=utf-8",
  "Content-Disposition": contentDisposition(`${filenameFor(scope)}.md`),
  "Cache-Control": "no-store",
} });
```

**授權檢查點(三處,缺一不可):**(1) `scopeSql()` 的 `params[0]` 永遠是 `c.var.email`(Task 2.1 已由測試把關);(2) `personal_notes` 查詢 `WHERE user_email = ? AND question_id IN (…)`;(3) `highlights` 查詢 `WHERE user_email = ?` 後再於記憶體用 qid 過濾 store_key。三者的 email 一律取自 `c.var.email`,**永不接受 body 傳入**。

- **Step 3:** 中文檔名要同時給 ASCII fallback 與 RFC 5987,否則 Safari 拿到亂碼(放 `export-doc.ts`,附測試):

```ts
export function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
```

- **Step 4 — 驗證**(`pnpm dev` + `cd frontend && pnpm dev`,Vite proxy 注入 `X-Dev-Email`;若 API 全數 500/404,先確認 8787 沒被 OpenEvidence MCP relay 佔走):

```bash
H="-H 'Content-Type: application/json' -H 'X-Dev-Email: <admin_email>'"
curl -s -X POST http://localhost:8787/api/export/preview $H -d '{"scope":{"kind":"year","year":114}}'
curl -OJ -X POST http://localhost:8787/api/export $H \
  -d '{"scope":{"kind":"ids","ids":["114-001","114-002"]},"format":"md"}'
```

- **Step 5:** `git commit -m "feat(export): POST /api/export markdown endpoint with scoped auth"`

---

## Task 3.1: CSV 產生器(TDD)

**Files:** Create `worker/lib/export-csv.ts` / Test `worker/lib/export-csv.test.ts`

- **Step 1 — 失敗測試:** `csvCell()` 對含逗號 / 雙引號 / 換行 / 前導空白的值要用 `"` 包住並把 `"` 加倍;`renderExportCsv(items)` 首行起輸出 Anki 匯入指令標頭:

```
#separator:Comma
#html:true
#notetype:血專
#deck:血專::匯出
#columns:Front,Back,Tags
#tags column:3
```

  Front/Back 用 **Task 1.1 的 `docToHtml`**,結構對齊 `scripts/build-anki.py:656-668`(`.qid` / `.stem` / `ul.options` / `.answer` / `.expl`),再追加 `.note`(我的筆記)與 `.hl`(我的畫記)。Tags 欄 = `question_tags` + `年份-114`,空白換 `_`(Anki tag 不能有空白)。圖片 `<img src>` 一律改寫成**絕對 URL**,測試斷言不出現相對路徑。
- **Step 2:** FAIL → **Step 3** 實作 → **Step 4** PASS(`pnpm test`)。
- **Step 5:** `git commit -m "feat(export): Anki-importable CSV renderer"`

**已知 caveat(必須寫進 UI 文案):** 第一版不輸出 guid column,匯入的卡與 `anki-deck/*.apkg` 的卡是**不同 note**,同一題會出現兩張。要合併需移植 genanki `guid_for("hema-2026", id)` 的雜湊演算法(對照 genanki 原始碼確認,並用既有 apkg 實測驗證)再加 `#guid column:`。另外 Anki 不抓遠端圖,絕對 URL **離線看不到圖且需已登入 Access**。

---

## Task 3.2: CSV 接上端點

**Files:** Modify `worker/routes/export.ts` / `wrangler.toml`(若 `[vars]` 尚無 `PUBLIC_HOST` 則新增,同步 `config.toml` + `config.example.toml`)

- **Step 1:** `format: "csv"` 分支 → `Content-Type: text/csv; charset=utf-8`,檔名 `.csv`,開頭補 UTF-8 BOM(否則 Excel 開中文亂碼;Anki 能容忍 BOM)。
- **Step 2:** 絕對 URL 的 origin 取自 `c.env.PUBLIC_HOST`(worker 不讀 `config.toml`,見 CLAUDE.md),**不得 hard-code**。
- **Step 3:** 驗證 `curl -OJ … -d '{…,"format":"csv"}'`,實際拖進 Anki 匯入,確認 notetype / deck / tags 都對。
- **Step 4:** `git commit -m "feat(export): csv format with absolute image URLs"`

---

## Task 4.1: 前端下載能力 + 匯出對話框

**Files:** Modify `frontend/src/lib/api.ts` / Create `frontend/src/components/ExportDialog.tsx`

- **Step 1:** `api.ts` 補 blob 下載(現有 `request()` 一律 `JSON.parse`,不能用,`frontend/src/lib/api.ts:37`):

```ts
download: async (path: string, body: any): Promise<void> => {
  const res = await fetch(path, { method: "POST", credentials: "include",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new ApiError(res.status, await res.text());
  const m = /filename\*=UTF-8''([^;]+)/.exec(res.headers.get("Content-Disposition") || "");
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = url; a.download = m ? decodeURIComponent(m[1]) : "export"; a.click();
  URL.revokeObjectURL(url);
},
```

- **Step 2:** `ExportDialog.tsx`,props `{ scope: ExportScope; onClose: () => void }`。掛載時打 `/api/export/preview` 顯示「將匯出 N 題(範圍標籤)」;格式二選一(Markdown / Anki CSV,各附一句用途);三個 include checkbox;超過 200 題停用按鈕並提示縮小範圍。視覺沿用 ink/cream + `#a8442a` accent(`frontend/tailwind.config.js:21`),不引入新設計語彙。
- **Step 3:** `cd frontend && pnpm build` 過 → `git commit -m "feat(ui): export dialog + blob download helper"`

---

## Task 4.2: 各入口接上匯出按鈕

**Files:** Modify `frontend/src/routes/Bookmarks.tsx`(主入口:側欄四個分類 `:25-28` → `folder` / `bookmarks` / `notes` / `highlights`)、`YearList.tsx`(`year`)、`Search.tsx`(結果 id → `ids`)、`ExamResult.tsx`(`exam`,附「只匯出答錯的」開關)、`ReviewIndex.tsx`(錯題 → `wrong`)

- **Step 1:** 每頁一顆一致的「匯出」按鈕(同 icon、同文案),開 `ExportDialog`。
- **Step 2:** 手動走完五個入口各一次,確認下載的 `.md` 內含且**只含**自己的筆記與畫記。
- **Step 3(安全驗收關鍵):** 換 `X-Dev-Email` 成第二個帳號,對同一個 folder id 打 `/api/export`,**必須**回空範圍或 400,不能拿到別人的收藏。
- **Step 4:** `git commit -m "feat(ui): export entry points across bookmarks/year/search/exam/wrong"`

---

## Task 5.1: 圖片內嵌(base64)與 HTML 格式

**Files:** Modify `worker/routes/export.ts` / Create `worker/lib/export-images.ts` + `worker/lib/export-images.test.ts`

- **Step 1 — 失敗測試:** `collectImageKeys(items)` 從所有 TipTap doc 走出 `/img/<key>`(去重、排除 http(s) 外連、拒 `..`);`planEmbed(keys, { maxCount: 20, maxBytes: 4_000_000 })` 回 `{ embed, skipped }`。
- **Step 2:** 實作。R2 讀取用 `c.env.R2.get(key)`(與 `worker/routes/images.ts:15` 同路徑,**bucket 維持私有**),並行度限 6,累計超過 `maxBytes` 就停止並把其餘丟進 `skipped`。
- **Step 3:** `format: "md"` 加 `embed_images: true` → renderer 的 `opts.imageSrc` 回 `data:<mime>;base64,…`;被 skip 的維持 `/img/<key>`,檔尾附「N 張圖片因體積上限未內嵌」。
- **Step 4:** 新增 `format: "html"` — 用 `docToHtml` 包成自帶 `<style>` 的單檔(排版思路參考 `scripts/build-anki.py:141-486`,但配色改成本站 ink/cream 而非 catppuccin)。UI 說明「用瀏覽器列印成 PDF」。
- **Step 5:** 驗證體積與耗時:`curl -OJ` 一個含圖的 20 題範圍,`ls -lh` 確認 < 5 MB,`wrangler tail` 看 CPU time 未超標。
- **Step 6:** `pnpm test` → `git commit -m "feat(export): base64 image embedding + single-file HTML format"`

---

## Task 6(選配): 瀏覽器端 ZIP 打包

**Files:** Modify `worker/routes/export.ts`(新增 `format: "bundle"` → 回 JSON `{ markdown, images: string[] }`)、`frontend/src/components/ExportDialog.tsx`、`frontend/package.json`(加 `fflate`,~8 KB gzip)

前端拿到 bundle 後對每個 `/img/<key>` 自行 `fetch`(Access cookie 自動帶),用 fflate 打包成 `<範圍>.zip`(`index.md` + `images/`)。圖片下載的 CPU 與頻寬因此落在瀏覽器,**完全繞開 worker 的 CPU 與體積上限** —— 這是大範圍下唯一能保住圖片的路徑,但只在 Task 5 的限額被實際打到時才做。

`git commit -m "feat(export): browser-side zip bundling with images"`

---

## 驗收清單

- [ ] `pnpm test` 全綠(重點:`tiptap-render.test.ts` 涵蓋每種 node、巢狀 list、空 doc、未知節點降級)
- [ ] `pnpm exec tsc --noEmit` 與 `cd frontend && pnpm build` 皆過
- [ ] 五個入口(收藏資料夾 / 錯題 / 某一年 / 搜尋結果 / 測驗結果)都能匯出,範圍標籤與檔名正確
- [ ] Markdown 檔在 Obsidian / VS Code / GitHub 三處預覽正常,中文檔名不亂碼
- [ ] CSV 實際匯入 Anki:notetype `血專`、deck、tags 正確,HTML 有渲染
- [ ] **A 帳號無法匯出 B 帳號的收藏 / 筆記 / 畫記**(Task 4.2 Step 3 已實測)
- [ ] 匯出檔中不出現他人 email 或他人筆記內容
- [ ] 201 題的範圍回 413 且 UI 有可讀提示,不是白畫面
- [ ] `wrangler tail` 觀察一次 200 題匯出,CPU time 未超標
- [ ] R2 bucket 仍為私有(dashboard 確認未開公開存取)

## 風險與回滾

- **Worker CPU 10 ms 上限**是最大的未知數。若 200 題實測就爆,先降 `MAX_QUESTIONS` 到 100,再考慮把 Markdown 組裝整段移到前端(worker 只回 JSON)—— Task 6 的 bundle 模式已是這條路的雛形。
- **回滾成本近乎零:** 不加 migration、不改任何既有 route、不改 schema。移除 `app.route('/api/export', …)` 與五個 UI 按鈕即完全復原。
- **`scripts/build-anki.py` 完全不動** —— 全年份完整 apkg 仍由它產生。兩條路徑刻意共存:離線腳本負責「全部」,App 內匯出負責「我選的」。
- **私有內容外洩是本計畫唯一的高風險項。** 防線是 Task 2.1 的「每個 kind 都有 params[0] 必為 email」測試 + Task 4.2 Step 3 的跨帳號實測;任何新增 scope kind 都必須同時補這兩處。
- CSV 與既有 apkg 的卡片重複(無 guid)是**已知且可接受**的第一版限制,必須在 UI 文案講清楚,不要讓使用者事後才發現。

## 成本

**$0** —— 無新增 Cloudflare 服務、無新綁定、無 Workers AI 呼叫、無 Vectorize 查詢。純 D1 讀取(每次匯出 ≈ 5 個 query,遠低於免費額度)與既有 R2 讀取(僅 Task 5 內嵌圖片時)。前端唯一可能的新相依是 Task 6 的 `fflate`(~8 KB gzip),對 bundle 預算無感。

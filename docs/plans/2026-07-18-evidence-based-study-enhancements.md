# 實證學習增強功能 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在 hema-2026 現有的 FSRS + exam/review 之上,加四個實證學習法功能:語意交錯練習(#2)、答前信心校準(#4)、自動 cloze 挖空(#5)、弱點概念聚類地圖(#6)。

**Architecture:** 一次性回填 1000 題的 BGE 向量到 Cloudflare Vectorize,成為 #2 相似題與 #6 聚類的共同基礎。#4 純資料(D1)、#5 用 Workers AI 離線抽取關鍵詞後快取到 D1 並重用現有 `<mark>` cloze 渲染。全部落在 Cloudflare free tier。

**Tech Stack:** Cloudflare Workers (Hono) + D1 (SQLite) + **Vectorize** (新增) + Workers AI (`@cf/baai/bge-base-en-v1.5` 768 維, `@cf/meta/llama-3.1-8b-instruct`)。前端 React 18 + Vite + TipTap。測試 `node --test`(`node:test` + `node:assert/strict`,`.ts` 直接 import)。

**執行順序(使用者指定):** M2 → M4 → M5 → M6。每個 milestone 可獨立 ship。

**跨切面約定:**
- 資源名走 `config.toml`,禁止 hard-code slug/host(見 CLAUDE.md)。Vectorize index 名要進 `config.example.toml` + `config.toml`。
- migration 一律新增,不改已套用的檔(現有最後一支是 `0019_search_history.sql`)。
- 測試檔與原始碼同目錄 `*.test.ts`。純函式優先抽出、先寫失敗測試。
- 每個 task 結束就 commit。

---

## Milestone 2 — 語意相似題 → 交錯練習引擎

**證據:** Interleaving(Rohrer & Taylor 2007;Dunlosky 2013 中效用)+ desirable difficulty(Bjork)。現有 `/:id/similar` 只做 tag 重疊 + BM25 詞面(`worker/routes/questions.ts:299`),抓不到「同機轉、不同 vignette」。

**成果:** (a) `/:id/similar` 前置一層 Vectorize 語意鄰居;(b) 新 `/api/drill/interleave` 回傳跨年份洗牌的交錯 mini-set;(c) 前端「交錯練習」入口。

### Task 2.1: 建立 Vectorize index + binding

**Files:**
- Modify: `wrangler.toml`(在 `[ai]` 區塊後新增)
- Modify: `config.example.toml` 與 `config.toml`(`[project]` 加 `vectorize_index = "hema-2026-vec"`)
- Modify: `scripts/deploy.sh`(建 index 的冪等步驟,仿 D1 create 那段)

**Step 1:** 手動建立 index(768 維、cosine):
```bash
wrangler vectorize create hema-2026-vec --dimensions=768 --metric=cosine
```
Expected: 成功或 `already exists`(冪等,忽略後者)。

**Step 2:** `wrangler.toml` 新增 binding:
```toml
# 語意相似題 / 弱點聚類共用的向量索引(1000 題 × 768 維 ≈ 0.77M dims,免費上限 5M)
[[vectorize]]
binding = "VEC"
index_name = "hema-2026-vec"
```

**Step 3:** `worker/types.ts` 的 `Env` 加 `VEC: VectorizeIndex`(找到 `AI:` 那行旁邊加)。

**Step 4:** `deploy.sh` 在建 R2 bucket 那段附近加冪等 create:
```bash
VEC_INDEX=$(cfg project.vectorize_index)
wrangler vectorize create "$VEC_INDEX" --dimensions=768 --metric=cosine 2>/dev/null || true
```

**Step 5:** `pnpm exec tsc --noEmit`(型別過)後 commit：
```bash
git add wrangler.toml worker/types.ts config.example.toml config.toml scripts/deploy.sh
git commit -m "feat(vectorize): add VEC index binding for semantic similarity"
```

### Task 2.2: 抽出 similar 合併邏輯(TDD)

**Files:**
- Create: `worker/lib/similar.ts`
- Test: `worker/lib/similar.test.ts`

把「向量鄰居 + tag + BM25」三來源的去重合併變成純函式,方便測。

**Step 1 — 失敗測試** `worker/lib/similar.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeSimilar } from "./similar.ts";

test("向量鄰居優先、去重、排除自身、補到上限", () => {
  const self = "114-001";
  const vec = [{ id: "113-050", score: 0.9 }, { id: "112-010", score: 0.8 }, { id: "114-001", score: 1 }];
  const tag = [{ id: "112-010" }, { id: "111-003" }];
  const fts = [{ id: "110-020" }];
  const out = mergeSimilar({ self, vec, tag, fts, limit: 3 });
  assert.deepEqual(out.map((r) => r.id), ["113-050", "112-010", "111-003"]);
  assert.equal(out[0].source, "vec");
  assert.equal(out[2].source, "tag");
});

test("向量結果不足時用 fts 補滿", () => {
  const out = mergeSimilar({ self: "x", vec: [], tag: [], fts: [{ id: "a" }, { id: "b" }], limit: 5 });
  assert.deepEqual(out.map((r) => r.id), ["a", "b"]);
});
```

**Step 2:** `node --test worker/lib/similar.test.ts` → FAIL(找不到模組)。

**Step 3 — 實作** `worker/lib/similar.ts`:
```ts
export type SimSource = "vec" | "tag" | "fts";
type VecHit = { id: string; score: number };
type IdRow = { id: string };
export type Merged = { id: string; source: SimSource };

export function mergeSimilar(input: {
  self: string;
  vec: VecHit[];
  tag: IdRow[];
  fts: IdRow[];
  limit: number;
}): Merged[] {
  const seen = new Set<string>([input.self]);
  const out: Merged[] = [];
  const push = (id: string, source: SimSource) => {
    if (seen.has(id) || out.length >= input.limit) return;
    seen.add(id);
    out.push({ id, source });
  };
  for (const v of [...input.vec].sort((a, b) => b.score - a.score)) push(v.id, "vec");
  for (const t of input.tag) push(t.id, "tag");
  for (const f of input.fts) push(f.id, "fts");
  return out;
}
```

**Step 4:** `node --test worker/lib/similar.test.ts` → PASS。

**Step 5:** commit `feat(similar): pure merge helper for vec+tag+fts sources`。

### Task 2.3: 回填腳本 — 1000 題 → Vectorize

**Files:**
- Create: `scripts/backfill-vectors.ts`
- Modify: `package.json`(scripts 加 `"vectors:backfill"`)

用 embed 模型把每題 `stem + options + tags` 向量化,upsert 到 VEC,metadata 存 `{year, group, tags}`(供 #6 過濾)。走 Worker 的 `/api/ai/embed` 或直接呼叫 Cloudflare AI REST。**建議**:寫成呼叫 REST API 的 node 腳本,分批(每批 100)避免逾時。

**Step 1:** 讀 `wrangler d1 execute ... --command "SELECT id, stem, options_json, ..."` 匯出題目 JSON;或直接 `wrangler d1 export`。腳本內組 `text = stem + '\n' + options + '\n' + tags`。

**Step 2:** 對每題呼叫 embed(REST：`POST /accounts/{acct}/ai/run/@cf/baai/bge-base-en-v1.5`,body `{ text: [...] }`),取 `result.data[0]`。

**Step 3:** upsert 到 Vectorize REST(`POST /accounts/{acct}/vectorize/v2/indexes/{name}/upsert`,ndjson:`{"id","values","metadata"}`)。metadata 帶 `year`(number)、`group`(string)、`tags`(string, 逗號串)。

**Step 4:** 加 `--dry-run` 印前 3 筆不上傳。跑 `--dry-run` 驗證維度=768。

**Step 5:** commit `feat(scripts): backfill question vectors into Vectorize`。**注意**:回填是一次性 remote 操作,計畫執行者跑之前先問使用者。

### Task 2.4: 升級 `/:id/similar` 接 Vectorize

**Files:**
- Modify: `worker/routes/questions.ts:299-360`

**Step 1:** 在既有 handler 開頭,先 embed 本題 stem(`c.env.AI.run(EMBED_MODEL, {text:[self.stem]})`,EMBED_MODEL 從 ai.ts 複製常數或抽到共用),`c.env.VEC.query(vector, { topK: limit + 5, returnMetadata: false })`。

**Step 2:** 把 vec hits → `mergeSimilar({ self:id, vec, tag:byTag, fts:byFts, limit })`;原本的 tag 查詢與 BM25 fallback 保留當第二三來源。最後用合併後的 id 清單一次 `SELECT` 補齊顯示欄位(year/number/stem/group),依合併順序輸出。

**Step 3:** VEC 或 embed 失敗要 try/catch 靜默降級回原本 tag+BM25(不可讓相似頁 500)。

**Step 4:** 本地 `pnpm dev` + 開 `/question/114-001` 的「相似」分頁,確認有結果且不報錯(向量若沒回填則應降級,不 crash)。

**Step 5:** commit `feat(similar): prepend Vectorize semantic neighbors, graceful fallback`。

### Task 2.5: 交錯練習 API + 前端入口

**Files:**
- Create: `worker/routes/drill.ts`
- Modify: `worker/index.ts`(`app.route('/api/drill', drillRoutes)`)
- Modify: `frontend/src/routes/Question.tsx`(相似分頁加「開始交錯練習」按鈕)

**Step 1:** `GET /api/drill/interleave?anchor=<id>&n=5`:embed anchor → VEC query topK=n*3 → 依 metadata 盡量挑**不同年份**(交錯的關鍵:同主題跨年)→ 洗牌(用 anchor id 的字元和當 seed,避免 `Math.random` 在 worker 測試環境問題)→ 回傳題目卡陣列(id/year/number/stem/options)。

**Step 2:** 洗牌與選題邏輯抽 `worker/lib/drill.ts` 的純函式 `pickInterleaved(hits, {n, seed})` 並 TDD(測「盡量跨年」「長度=n」「去重 anchor」)。

**Step 3:** 前端:相似分頁底部一顆按鈕 → 導到既有作答流程,依序過這 n 題(可複用 QuestionCard 逐題),不需新做整套 UI。

**Step 4:** 本地驗證一輪交錯練習可完整作答。

**Step 5:** commit `feat(drill): interleaved practice set from semantic neighbors`。

---

## Milestone 4 — 答前信心評分(JOL / calibration)

**證據:** 作答前評信心提升 monitoring accuracy(Nelson & Dunlosky);校準回饋讓「高信心卻答錯」的盲點可見(這是後設認知的關鍵產出)。**本 milestone 不做 hypercorrection 生成(#3 已跳過)**,只捕捉信心 + 顯示校準。

### Task 4.1: migration + 校準分桶純函式(TDD)

**Files:**
- Create: `migrations/0020_answer_confidence.sql`
- Create: `worker/lib/calibration.ts` + `worker/lib/calibration.test.ts`

**Step 1 — migration:**
```sql
-- 答前信心事件(每次作答一筆,供校準曲線與「高信心錯題」清單)
CREATE TABLE confidence_events (
  user_email  TEXT NOT NULL REFERENCES users(email),
  question_id TEXT NOT NULL REFERENCES questions(id),
  confidence  INTEGER NOT NULL,   -- 1=猜 2=普通 3=有把握
  is_correct  INTEGER NOT NULL,   -- 0/1
  at          INTEGER NOT NULL
);
CREATE INDEX idx_conf_user ON confidence_events(user_email, at DESC);
```
套用:`pnpm db:migrate:local`。

**Step 2 — 失敗測試** `calibration.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { calibration } from "./calibration.ts";

test("依信心分桶算正確率", () => {
  const out = calibration([
    { confidence: 3, is_correct: 1 }, { confidence: 3, is_correct: 0 },
    { confidence: 1, is_correct: 0 },
  ]);
  assert.deepEqual(out.find((b) => b.confidence === 3), { confidence: 3, n: 2, correct: 1, accuracy: 0.5 });
  assert.equal(out.find((b) => b.confidence === 1)!.accuracy, 0);
});
```

**Step 3 — 實作** `calibration.ts`:分 1/2/3 三桶,各算 `n / correct / accuracy`(n=0 時 accuracy=null)。

**Step 4:** `node --test worker/lib/calibration.test.ts` → PASS。

**Step 5:** commit `feat(calibration): confidence_events table + bucketing helper`。

### Task 4.2: API — 收信心 + 回校準

**Files:**
- Modify: `worker/routes/review.ts:134-157`(`/answer`)
- Modify: `worker/routes/review.ts`(新增 `GET /calibration`)

**Step 1:** `/answer` body 型別加 `confidence?: number`。算完 `isCorrect` 後,若 `confidence` 為 1/2/3,`INSERT INTO confidence_events`。信心是 optional,不傳照舊運作(向後相容 exam 流程)。

**Step 2:** 新增 `GET /api/review/calibration` → 讀該 user 全部 `confidence_events` → `calibration(rows)` → 另附「高信心錯題」清單(`confidence=3 AND is_correct=0` 的最近 20 題,join 題目 year/number/stem)。

**Step 3:** 本地 `curl` POST 一筆帶 confidence 的作答,再 GET calibration 確認數字對。

**Step 4:** commit `feat(review): capture pre-answer confidence, expose calibration`。

### Task 4.3: 前端 — 作答前信心選擇 + 校準面板

**Files:**
- Modify: `frontend/src/components/QuestionCard.tsx`(submit 前的信心 UI)
- Modify: `frontend/src/routes/ReviewIndex.tsx` 或 `Profile.tsx`(校準面板)

**Step 1:** QuestionCard:選好選項、按「作答」前,顯示三顆小按鈕「猜 / 普通 / 有把握」(預設「普通」)。`submit()` 把 `confidence` 一起 POST(`review/answer` 已改為接受)。維持既有 UI 語氣(scholarly,無漸層)。

**Step 2:** 新校準面板元件 `ConfidenceCalibration.tsx`:呼叫 `/api/review/calibration`,畫三桶正確率(簡單長條,沿用現有色盤 ink/cream/單一 accent),下方列「你標『有把握』卻答錯」清單,每項連到該題。

**Step 3:** 掛到複習首頁或個人頁。本地驗證作答→面板數字更新。

**Step 4:** commit `feat(ui): pre-answer confidence + calibration panel`。

---

## Milestone 5 — 自動 cloze 挖空(不接 FSRS)

**證據:** Generation effect(Slamecka & Graf 1978)。現有 cloze 靠人工 highlight(`AnnotatableContent`,localStorage/裝置本地)。這裡讓 Workers AI 自動抽關鍵詞、快取到 D1 共享,套用現有 `<mark>` 渲染即自動挖空。**明確不做:** 不生成 FSRS 卡,只做詳解自我測驗層。

### Task 5.1: migration + 純文字抽取 + 詞跨度比對(TDD)

**Files:**
- Create: `migrations/0021_explanation_cloze.sql`
- Create: `worker/lib/cloze.ts` + `worker/lib/cloze.test.ts`

**Step 1 — migration:**
```sql
-- 自動 cloze 關鍵詞快取(每題 × 詳解版本算一次,20 人共享)
CREATE TABLE explanation_cloze (
  question_id TEXT PRIMARY KEY REFERENCES questions(id) ON DELETE CASCADE,
  version     INTEGER NOT NULL,   -- 對應 explanations.version,版本變則重算
  terms_json  TEXT NOT NULL,      -- string[] 關鍵詞
  created_at  INTEGER NOT NULL
);
```

**Step 2 — 失敗測試** `cloze.test.ts`:測 `explanationPlainText(doc)` 從 TipTap JSON 攤平純文字(參考 `worker/lib/note-doc.ts` 的 PMNode 走訪法),及 `dedupeTerms(terms)`(去重、去空白、長度過短剔除、上限 10)。
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { explanationPlainText, dedupeTerms } from "./cloze.ts";

test("攤平 TipTap 文字", () => {
  const doc = { type: "doc", content: [
    { type: "paragraph", content: [{ type: "text", text: "CML 帶有 " }, { type: "text", text: "BCR-ABL1" }] },
  ]};
  assert.equal(explanationPlainText(doc), "CML 帶有 BCR-ABL1");
});

test("關鍵詞去重去雜訊限量", () => {
  assert.deepEqual(dedupeTerms([" BCR-ABL1 ", "BCR-ABL1", "的", "TKI"]), ["BCR-ABL1", "TKI"]);
});
```

**Step 3 — 實作** `cloze.ts`:遞迴走訪節點收集 `text`;`dedupeTerms` trim → 過濾長度<2 → 去重 → slice(0,10)。

**Step 4:** `node --test worker/lib/cloze.test.ts` → PASS。

**Step 5:** commit `feat(cloze): plaintext extract + term dedupe helpers`。

### Task 5.2: API — 抽關鍵詞並快取

**Files:**
- Modify: `worker/routes/questions.ts`(新增 `GET /:id/auto-cloze`)

**Step 1:** handler:讀 `explanations`(content_json + version)。若 `explanation_cloze` 有該題且 `version` 相符 → 直接回 `terms_json`。否則 `explanationPlainText` → Workers AI(`TEXT_MODEL`,`response_format` json_schema 要 `{ terms: string[] }`,prompt:「挑出最值得考的 5–8 個關鍵詞/數值/藥名,原文照抄不要改寫」)→ `dedupeTerms` → upsert 快取 → 回傳。

**Step 2:** neurons 控量:只在使用者按按鈕時算、且版本命中即快取,不在頁面載入自動算。

**Step 3:** 本地對一題有詳解的題 `curl` 兩次,第二次應命中快取(可加 log 或回 `cached:true`)。

**Step 4:** commit `feat(cloze): AI keyword extraction endpoint with D1 cache`。

### Task 5.3: 前端 — 自動挖空開關

**Files:**
- Modify: `frontend/src/components/AnnotatableContent.tsx`(加 `autoTerms?: string[]` prop)
- Modify: `frontend/src/routes/Question.tsx`(詳解分頁加「自動挖空」按鈕)

**Step 1:** `AnnotatableContent` 新 prop `autoTerms`:載入內容後,對每個 term 在 DOM 文字中找出現位置,用 TipTap `setTextSelection` + `toggleHighlight`(或直接包 `<mark>`)套 highlight。這些自動 mark 與人工 mark 同類,現有 `cloze` 模式即可把它們變空格。

**Step 2:** Question.tsx 詳解分頁:一顆「自動挖空」→ `GET /api/questions/:id/auto-cloze` 取 terms → 傳給 `AnnotatableContent` 的 `autoTerms` 並開啟 cloze 模式。再按「取消」還原(既有防劇透 toggle 已有還原路徑)。

**Step 3:** 本地:一題詳解按「自動挖空」→ 關鍵詞變空格、點擊逐一揭示。

**Step 4:** commit `feat(ui): auto-cloze toggle wired to AI keyword endpoint`。

---

## Milestone 6 — 弱點概念聚類地圖(診斷工具)

**證據定位:** retrieval practice > concept mapping(Karpicke & Blunt 2011),所以這**定位成診斷**,不是學習法本身:把使用者錯題的向量聚類,命名主題,導回 M2 的交錯練習。依賴 M2 的 Vectorize 向量。

### Task 6.1: 聚類純函式(TDD)

**Files:**
- Create: `worker/lib/cluster.ts` + `worker/lib/cluster.test.ts`

**Step 1 — 失敗測試:** `clusterByThreshold(items, {threshold})`,items=`{id, vector}[]`,用貪婪近鄰(cosine)把相近題歸同群,回 `{members: string[]}[]`,依群大小降序。測「兩個明顯分開的群被正確分成 2 群」「單題自成一群」。

**Step 2:** `node --test worker/lib/cluster.test.ts` → FAIL。

**Step 3 — 實作** `cluster.ts`:cosine 相似度 + 貪婪:每題找已存在群的質心,`>threshold` 就加入否則開新群;回傳前重算群大小排序。純函式、不碰 D1/VEC。

**Step 4:** PASS → commit `feat(cluster): greedy cosine clustering helper`。

### Task 6.2: 弱點地圖 API

**Files:**
- Modify: `worker/routes/review.ts`(新增 `GET /weakness-map`)

**Step 1:** 取該 user 的錯題 id(`review_progress` 中 `last_correct=0`,或 `times_seen>0 AND times_correct*2 < times_seen` 的低正確率題),上限如 60 題。

**Step 2:** 用這些 id 從 VEC `getByIds` 拿回向量 → `clusterByThreshold` → 每群取代表題,呼叫 Workers AI 給群一個主題標籤(≤8 字,快取到 KV 或簡化為用該群最高頻 tag 當標籤以省 neurons)。**建議 YAGNI:** 先用「該群出現最多的 tag」當標籤,不呼叫 AI;要更好再加。

**Step 3:** 回傳 `{ clusters: [{ label, size, question_ids }] }`,每群附一個「開始交錯練習」的 anchor(群內任一題)導到 `/api/drill/interleave`。

**Step 4:** 本地驗證(需先回填向量 + 有錯題資料)。commit `feat(review): weakness clustering map endpoint`。

### Task 6.3: 前端弱點地圖頁

**Files:**
- Create: `frontend/src/routes/WeaknessMap.tsx`
- Modify: `frontend/src/App.tsx`(加 route)+ 複習首頁入口

**Step 1:** 頁面:呼叫 `/api/review/weakness-map`,每群一張卡(標籤 + 題數 + 「交錯練習」按鈕連到 M2 drill)。沿用現有視覺語氣。

**Step 2:** 空狀態:錯題不足時顯示「多做幾題再回來看弱點分布」。

**Step 3:** 本地驗證整條:錯幾題 → 弱點地圖出現分群 → 點交錯練習進 M2 流程。

**Step 4:** commit `feat(ui): weakness map page linking to interleaved drills`。

---

## 收尾檢查(每個 milestone 完成後)

- `node --test 'worker/**/*.test.ts'` 全綠
- `pnpm exec tsc --noEmit`(worker)+ `cd frontend && pnpm build` 型別/建置過
- 相關頁面本地手動走一遍(見各 task 的驗證步驟)
- free-tier 確認:Vectorize dims < 5M、Workers AI 呼叫都有快取或 on-demand、無新增付費服務

## 風險與備註

- **回填向量(2.3)是一次性 remote 寫入**,執行者動手前先問使用者;可先 `--dry-run`。
- **Workers AI 免費 10K neurons/day**:#5 抽詞與 #6 命名都必須「按需 + 快取」,禁止頁面載入自動觸發。
- 若之後要把 #5 cloze 升級成 FSRS 卡(本計畫明確不做),D1 的 `explanation_cloze` 已保留 terms,屆時再加卡表即可。
- 文獻為經典高被引來源;若要放進 repo 給組員,另用 PubMed MCP 核對 DOI 產一份正式引用版。

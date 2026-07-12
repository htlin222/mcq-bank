# LESSONS.md — 踩坑紀錄與可複用教訓

從 155 個 commit(cd49dfa 初始上線 → 2e3f9a7)萃取的 hard-won lessons。
每條格式:**發生什麼 → 教訓 → 抽象原則**。新坑請持續補記。

---

## 1. Cloudflare 平台

### 1.1 CF Access 會把「公開端點」也擋掉
- **坑**:公開 API(`/api/mcq/*`)、landing page、og:image、favicon 部署後被 Access 登入牆擋住(d4a5f8d、d0ff579)。
- **教訓**:CF Access 是全站的;任何要公開的 path 都要建 path-scoped bypass application(`scripts/setup-public-bypass.sh`)。
- **抽象**:Zero Trust 架構下,「公開」是需要明確宣告的例外,不是預設。新增公開路由時,bypass 清單是 deploy checklist 的一部分。

### 1.2 Cloudflare edge 會用 User-Agent 擋請求(error 1010)
- **坑**:Python urllib 預設 UA(`Python-urllib/x.y`)在到達 Worker 之前就被 edge 以 1010 拒絕。curl 測試通過、實際 skill 403(e3968ca)。
- **教訓**:任何打自家 CF 站的 script 都要送真實 UA。
- **抽象**:**用最終的封裝形式對 prod 測試**——curl 通過不代表 urllib 通過;開發環境通過不代表經過 edge 也通過。

### 1.3 SQLite-backed Durable Object 免費方案可用
- **坑**:文件與舊認知都說 DO 需要 Workers Paid,差點放棄聊天大廳。實際上 `new_sqlite_classes` 的 DO 免費方案就能跑(a660c10,CLAUDE.md 已更正)。
- **抽象**:平台限制的「常識」會過期;砍需求前先查當下的官方文件並實測。

### 1.4 FTS5 虛擬表會讓 `wrangler d1 export` 整庫匯出失敗
- **坑**:想鏡像 remote D1 到本地,整庫 export 被 FTS5 表擋死(6647756)。
- **教訓**:`db:pull` 的做法是——從 migrations 重建 schema,再只匯出/載入 base table 的資料;FTS 由 trigger/rebuild 補。
- **抽象**:衍生資料(index、FTS、cache 表)不進備份;備份 = schema(來自 migrations)+ base data。

### 1.5 本地開發 API 全掛,先懷疑 port 8787 被占
- **坑**:dev 環境所有 API 500/404,追了半天發現是 OpenEvidence MCP relay daemon 佔走 8787,wrangler 根本沒在聽。
- **抽象**:「全部同時壞掉」幾乎不會是程式碼問題——先檢查 process/port/環境,再看 code。

### 1.6 R2 一律走 Worker proxy,不開 public bucket
- 圖片 `/img/:key`、PDF `/pdf/*`(Range-capable,ebcd1e2)都經 Worker 驗證後 stream。公開 bucket 會讓 URL 外洩內容,破壞 Zero Trust 邊界。
- 新增一種靜態資產(如講義 PDF)= 新增一條 proxy route + wrangler route 設定(1887c7c 忘了就 404)。

---

## 2. 資料完整性(最痛的一課)

### 2.1 Re-import 無條件 upsert 會蓋掉社群修訂 ⚠️
- **坑**:importer 的 `ON CONFLICT DO UPDATE SET answer = excluded.answer` 把社群挑戰後升級的答案(114-002 B→C、114-003 A→D)silently 蓋回 CSV 原值,且不留 answer_history——DB 進入自我矛盾狀態(6647756)。
- **教訓**:import 前檢查 `answer_history` 是否存在;有人為修訂就保留 live answer,CSV 只更新 stem/options/meta。
- **抽象**:**任何欄位一旦「在 app 內可被人改動」,批次 pipeline 就不能再無條件寫它。** Upsert 必須 respect provenance:機器來源只能覆寫機器寫入的值。這條適用於所有「CSV/API 匯入 + 站內編輯」並存的系統。

### 2.2 匯入格式的邊角 case 要有 ground truth 驗證
- **坑**:K-type 複合題(組合選項題)被 importer 攤平,壞資料直接進庫;只有 110/111/113 有 docx 原始檔可以對答案。
- **抽象**:批次匯入要留原始檔對照,pre-flight validation(年份範圍、group 約束、ID 唯一)一項失敗就整批 abort——`import-questions.ts` 已是這樣設計,維持它。

### 2.3 索引基準(0-based vs 1-based)要在寫入端就統一
- **坑**:講義筆記顯示比資料落後一頁——`lecture_notes`/`lecture_pages`/pdfjs 全是 1-based,但 UI 某處用了 0-based(ad33627)。
- **抽象**:跨層(檔名、DB、library、UI)的序號,在設計文件裡寫死一個基準,轉換只在唯一一個邊界函式發生。

---

## 3. React / 前端

### 3.1 Hooks 不能在 early return 之後
- **坑**:`useMemo` 放在 `if (items === null) return` 之後,loading render 與 loaded render 的 hook 數不同 → React #310 直接 crash 整頁(d656e95)。
- **抽象**:所有 hooks 無條件在頂部執行,用 null guard 處理未載入狀態。這是 lint rule 能抓的,確保 `react-hooks/rules-of-hooks` 開著。

### 3.2 `position: sticky` 建立 stacking context,inline modal 會被困住
- **坑**:發生兩次(e227992 挑戰 modal、8676cfa feedback dialog)——modal 在 sticky/header 容器內 render,z-index 被 scope 在該 context 裡,畫在其他元素後面。
- **抽象**:**所有 modal/overlay 一律 portal 到 `document.body`**,z-index 用全站統一的 tier(本專案 modal = z-50)。不要 case-by-case 調 z-index。

### 3.3 Dark mode 沒有「順便支援」這回事
- **坑**:陸續修了三輪(cb1454f input 繼承黑字、f2c4fe0 五個 route 白卡、5d47145 全站 sweep)。
- **教訓**:input/textarea 不會繼承你以為的顏色;每個顏色 class 都要成對寫 light/dark。
- **抽象**:半套 dark mode 比沒有更糟。要嘛一開始就每個 class 成對,要嘛排一次全站 sweep 清完(grep 所有 `.tsx` 找無 `dark:` 配對的 `bg-`/`text-`)。

### 3.4 布局微坑
- `html { scrollbar-gutter: stable }`:內容跨過一個 viewport 高度時,scrollbar 出現造成整頁橫移(32480ba)。
- 桌機雙欄的斷點從 `lg` 降到 `md` 是實測後的決定(1671c50);desktop gate 不要憑感覺選。

---

## 4. 貼上/內容匯入 pipeline(TipTap)

外部來源的 HTML 是本專案最大的持續工程,教訓密度最高:

### 4.1 外部 HTML 永遠是畸形的,transform 要保守觸發
- **坑**:OpenEvidence 的 Copy Text 用 `<br><br>` 分段、`<img>caption</img>` 這種畸形結構(f242629);bullets 是 `- item<br><br>- item` 字面量(32480ba)。
- **教訓**:`transformPastedHTML` 重建段落/清單/圖片,但**只在偵測到特徵(2+ 連續 `<br>`)時觸發**,讓 Google Docs/Word 的正常貼上原樣通過。
- **抽象**:對外部格式做 heuristic 修復時,觸發條件要窄到只命中目標來源;寧可漏修,不可誤傷其他來源。

### 4.2 Hotlink 圖片必須 server-side sideload,而且要在插入前完成
- **坑 1**:googleapis 圖床擋 referrer 且 URL 會過期,貼上的 `<img>` 變破圖(62c3113)→ Worker 端 `/api/upload/url` 代抓(無 CORS/referrer 限制)存 R2。
- **坑 2**:fire-and-forget sideload 有 race——使用者搶在替換完成前存檔,第一張圖就永遠留外鏈(32480ba)→ 改成插入前併發上傳完 + progress bar。
- **抽象**:非同步修復使用者可見內容時,要問「使用者在修復完成前能不能 commit?」能,就必須改成 blocking(配 progress UI)。

### 4.3 Parse 第三方頁面要錨定語意,並留 fixture
- OpenEvidence 對話匯入(2e3f9a7)錨在 `<article>`、`data-answer-end` 等穩定語意,不是 class 名;並存一份對話 fixture 進 repo 供回歸驗證。
- **抽象**:scrape/parse 第三方 = 依賴會漂移的介面;錨最穩的 attribute + 存 fixture,是最低成本的保險。

### 4.4 存 TipTap JSON,不存 HTML(CLAUDE.md 既有決策,持續有效)
- read-only render 走同一組 extension,零 XSS;查詢 mention、字數都是結構化操作。

---

## 5. 可散佈 Skill(.skill 打包)的坑

### 5.1 SKILL.md 的 `<角括號>` placeholder 會被當 XML tag 吃掉
- `<年>-<題號>` 在 frontmatter description 直接被 loader parse 成 tag(392153b)。placeholder 用純文字。

### 5.2 路徑必須以 skill base dir 為錨,不能 cwd-relative
- 文件寫 `.claude/skills/mcq/scripts/...`,standalone 安裝後 cwd 不是 repo root,agent 每次都要探索半天(8e4da58)。改為 `"$SKILL/scripts/..."`,script 內用 `__file__` 解析 `.env`。
- **抽象**:可散佈的東西,對「安裝環境長怎樣」零假設:絕對路徑、自帶 config 解析、單步可跑。

### 5.3 驗證要用「打包後的最終產物」對 prod 跑一次
- UA 1010 事件(§1.2)就是這樣抓到的。dev 版通過 ≠ .skill 解包後在乾淨環境通過。

---

## 6. 安全(3f3ced0 一次收斂的原則)

| 原則 | 實作 |
|---|---|
| 不 reflect 任意 Origin | CORS allowlist same-origin + localhost;`credentials:true` + reflect = cookie ride 風險 |
| 錯誤詳情不出站 | detail 進 `wrangler tail`,client 只拿 generic message |
| 防 enumeration | 公開 API key 驗證:unknown-email 和 bad-key 回一致的 401 + constant-time compare |
| Proxy 回應加 `nosniff` | `/img`、`/pdf` 都加 `X-Content-Type-Options` |
| 上傳收斂 MIME | avatar/image 用 allowlist,不信 client 的 Content-Type |

---

## 7. 驗證方法論(跨主題的最大抽象)

### 7.1 typecheck/build 通過 ≠ 功能存在
兩個案例都是綠燈但功能全死,只有真瀏覽器操作才抓到:
- EmbedPDF 的 layers 沒包 `PagePointerProvider`:照常 render,但收不到 pointer event,選字完全沒反應(9d4267b)。
- pdfium 頁面是 `<img>`(預設 draggable),真滑鼠拖曳觸發原生 image drag 搶走文字選取——**synthetic test event 不會觸發原生 DnD,只有真滑鼠會**(5d6edda)。

**抽象**:涉及 pointer/drag/selection/clipboard 的功能,驗收必須是真瀏覽器手動 smoke test;自動化測試在這裡會給假陰性。

### 7.2 「Verified: <具體結果>」寫進 commit
本 repo 的好習慣:`Verified end-to-end: image fetched, stored, and rendered`、`Verified: 6-image OE paste → all 6 sideloaded`。強迫自己在 claim 完成前真的跑過。

### 7.3 瀏覽器內建行為是隱形依賴
html-to-image 在 blob: bitmap + cross-origin stylesheet 上直接炸(442cbc6)→ 改用 pdfium 自己的 `renderPage()`。**能用底層 library 的原生輸出,就不要在 DOM 上二次截圖/序列化。**

---

## 8. Fork-ready / 設定管理

- 所有 per-deploy 字串(slug、host、brand、admin email)單一來源 `config.toml`,各層有對應讀取 helper(add5f8f、47c98d2、111fc93;細節見 CLAUDE.md「Configuration model」)。
- **抽象**:開源化/fork-ready 不是最後一步的 find-replace,是「每次新增 per-deploy 值時就走 config」的紀律。事後清理(47c98d2)比一開始就做貴很多。
- Migrations 一旦 applied 永不改;衍生腳本(sync-access、import)設計成 idempotent,deploy.sh 可重跑。

---

## 9. 範圍紀律(20 人內部工具的定位)

- **Pessimistic lock 而非 CRDT**:20 人 × 1000 題,鎖 + 60s renew 就夠;Yjs 升級路徑保留但不實作。
- **通知不做 push**:badge on next load 就夠。聊天大廳例外地用了 WS,因為即時性是該功能的本質。
- **AI 功能是掛件不是核心**:in-editor AI 擴寫做了又拆掉(ff5daf5)——證明「先做上去再說」的 AI 功能常是負資產;改成把內容交給 OpenEvidence(使用者已有的工具)反而留下來了。
- **抽象**:每個功能先問「對 20 個使用者、免費額度,最笨但夠用的解是什麼」。這個 repo 裡被拆掉的功能(AI 擴寫、slide-deck skill)都是違反這條的。

---

## 10. 快速自查清單(新功能上線前)

- [ ] 新公開路由 → Access bypass 設了嗎?
- [ ] 新靜態資產類型 → Worker proxy route + wrangler route 都加了嗎?
- [ ] 新的可人為編輯欄位 → import pipeline 會不會蓋掉它?
- [ ] Modal/overlay → portal 到 body、z-50 了嗎?
- [ ] 每個顏色 class → 有 `dark:` 配對嗎?
- [ ] Hooks → 全部在 early return 之前嗎?
- [ ] pointer/drag/selection 功能 → 真瀏覽器手動測過嗎?
- [ ] 貼上 transform → 觸發條件窄到不誤傷其他來源嗎?
- [ ] 會不會把免費額度推爆?(推爆要明說,不默默加付費服務)

# 抹片練習(smear)模組總覽

更新:2026-09-06(#234 合併後)。這份是**模組地圖 + 規劃底稿**,不是 API 手冊。
設計理由的原文在 `docs/plans/2026-09-0{3,5}-smear-*.md`,踩坑紀錄分散在各檔檔頭,
這裡把它們收成一頁,好讓下一輪規劃不必重新考古。

| 想知道                     | 看哪一節     |
| -------------------------- | ------------ |
| 這模組在做什麼、跟 MCQ 差在哪 | §1           |
| 正式機現在有多少資料、有沒有人用 | §2           |
| 檔案在哪、端點有哪些         | §3、§4、§5   |
| 作答流程與防洩題            | §6           |
| 內容從哪裡來、怎麼灌         | §7           |
| 已經決定過、不要再提的方案    | §9           |
| 踩過的坑                    | §10          |
| 還沒做的、下一輪可以排的      | §11、§12     |

---

## §1 三十秒地圖

血液抹片判讀的**填空**練習:看一張顯微鏡圖,把診斷名稱**拼寫**出來。考卷上
抹片題就是填空,認得出 dacrocyte 但寫成 `dacrocite` 是 0 分,MCQ 題庫練不到這層。

三條貫穿整個模組的原則,每一個設計決定都能追回其中一條:

1. **跟 MCQ 在資料層完全分開。** 自己的表(`smear_*`)、自己的作答記錄(不進
   `attempts`)、自己的搜尋索引(`smear_fts`)、自己的收藏/筆記/討論表。首頁熱力
   圖、弱點地圖、成績頁都**不混入**抹片。
2. **組織單位是「診斷」(`smear_dx`),不是「題目」(`smear_questions`)。** 可接受
   寫法、詳解、收藏、筆記、討論全部掛 `dx_id`。一張圖只是那個診斷的一個實例。
3. **全真模式的價值建立在交卷前不揭曉任何判定資訊。** 所有「複習模式限定」的
   東西(提示、看答案、看選項、答後面板)都是 render-level 條件而不是 CSS 隱藏,
   而且伺服器端各自再擋一次(§6)。

判定分四層:`full`(1 分)→ `half`(0.5)→ `lay`(俗名,0 分但明講正解)→ `miss`。
**拼字錯不扣分,另計拼字正確率**:分數答「認不認得」,拼字答「寫不寫得出來」。

---

## §2 現況(正式機,2026-09-06 只讀查詢)

| 內容                         | 數量 | 備註                                                  |
| ---------------------------- | ---- | ----------------------------------------------------- |
| 診斷 `smear_dx`              | 103  | cell 54 / disease 49;七個 topic,`infection` 只有 3 個 |
| 題目 `smear_questions`       | 477  | exam 203 + ash 274;`po` 0、`submission` 0             |
| 可接受寫法 `smear_terms`     | 337  | 全部 `accepted`(full 295 / half 4 / lay 38);`open`/`rejected` 各 0 |
| 詳解 `smear_dx_notes`        | 103  | 每個診斷一份;#226 的英文形態描述句已上正式機(103/103)  |
| Migration                    | 0044 | 兩個 smear migration 都已套用                          |

| 使用                          | 數量 | 意思                                              |
| ----------------------------- | ---- | ------------------------------------------------- |
| `smear_sessions`              | 3    | 2 個使用者、**0 場交卷**、1 筆作答                  |
| 投稿 / 筆記 / 討論 / 收藏      | 0    | 社群功能上線後尚無任何寫入                          |
| 提報投票                      | 0    | 「這個寫法也該算對」流程還沒被任何人走過             |

**結論:功能面已完整上線,但實際上還沒有真人用過。** 這件事對規劃的意義有兩個:

- `scripts/smear/import.ts` 的 delete-then-insert **會清掉 `smear_sessions` /
  `smear_answers` / `smear_term_votes`**,現在重跑還無痛;一旦有人開始用,這條路
  就要先改(§11 的第一項)。
- 提示鏈、提報投票、投稿審核的設計假設(門檻 3 票、俗名比例、topic 分布)全部
  沒有真實資料驗證過。下一輪與其加功能,不如先讓 20 個人真的用一週再看數字。

topic 分布(本機鏡像同正式機):myeloid 28 · rbc 24 · lymphoid 22 ·
normal_reactive 11 · other 8 · platelet 7 · infection 3。**`infection` 只有 3 個診斷**,
抽題與看選項的「缺額回填」邏輯主要就是為它存在的。

---

## §3 資料模型

```
smear_dx  (103)            一個診斷:canonical_long / canonical_abbrev / topic / qtype
 ├ smear_terms             可接受寫法:tier(full|half|lay) / form(long|abbrev) / status(accepted|open|rejected)
 │  └ smear_term_votes     提報投票
 ├ smear_dx_notes          共筆詳解(TipTap JSON,鎖的形狀同 explanations)
 ├ smear_questions (477)   一張圖:source(exam|ash|po|submission) / image_key_view|full / prompt / image_note
 ├ smear_dx_bookmarks      收藏(per user)
 ├ smear_notes             個人筆記(per user,多則,有 sort_order 但 v1 沒做拖曳)
 └ smear_comments          討論串(parent_id 巢狀、deleted_at 軟刪)

smear_sessions             一場練習:mode(review|exam) / config_json / question_ids(抽好就固定)
 └ smear_answers           一題一列:typed_json / tier / score / spelling_errors_json / hint_used

smear_submissions          投稿待審佇列:status(pending|approved|rejected) / matched_dx_id
smear_fts                  FTS5:canonical + terms + topic + note(unicode61)
```

三條 schema 註解裡就寫著的硬規則(`migrations/0043_smear.sql`、`0044`):

- **alias / 詳解掛 dx 不掛題目**:同一個 dacrocyte 有考古題 1 張 + ASH 3 張,掛題目
  的話「dacryocyte 也算對」要改 4 筆,漏改的症狀是「同一個答案,這張圖算對那張算錯」。
- **作答不進 `attempts`**:那張表的 `question_id` 有 FK 指向 `questions`。
- **被否決的寫法留墓碑(`rejected`)不刪列**:唯一鍵 `(dx_id, norm)` 靠它擋重複提報。
- **錯題本從 `smear_answers` 推導**,沒有另外一張表。

`smear_terms.status` 同時是提報流程的狀態機;`smear_dx_notes` 的鎖欄位形狀同
`explanations`,但**目前前端沒有共筆編輯 UI**(詳解是離線產的,見 §7)。

---

## §4 程式地圖

| 層         | 檔案                                              | 職責                                                                 | 行數 |
| ---------- | ------------------------------------------------- | -------------------------------------------------------------------- | ---- |
| 純函式     | `worker/lib/smear-grade.ts`                       | `normalizeTerm()` / `gradeSmear()`:四層判定、Levenshtein ≤1(只給 ≥5 字) | 122  |
|            | `worker/lib/smear-pick.ts`                        | `pickSmearSet()` / `largestRemainder()` / `fisherYatesShuffle()`:分層抽樣 | 179  |
|            | `worker/lib/smear-mcq.ts`                         | `pickMcqOptions()` / `pickCorrectOptionLabel()`:看選項的干擾項         | 119  |
|            | `worker/lib/smear-proposal.ts`                    | 提報 / 投票 / 自動 resolve(`PROPOSAL_QUORUM = 3`)                      | 362  |
| 路由       | `worker/routes/smear.ts`                          | 練習主線:meta / sessions / answer / mc-options / finish / wrong / topic-stats / dx / search | 862  |
|            | `worker/routes/smear-terms.ts`                    | 提報與投票                                                            | 76   |
|            | `worker/routes/smear-community.ts`                | 收藏 / 筆記 / 討論 / 投稿審核                                          | 503  |
| 前端 API   | `frontend/src/lib/smearApi.ts`                    | 30 個 fetch 包裝 + `SMEAR_TOPIC_LABELS` 等中文對照                     | 555  |
| 前端頁面   | `frontend/src/routes/Smear.tsx`                   | `/smear` 六分頁殼 + `ModeCard`(SmearDashboard 也用)                   | 650  |
|            | `routes/SmearReview.tsx` / `SmearExam.tsx`        | 複習主題選擇頁 / 全真落地頁(都只是開 `StartDialog`)                    | 197 / 58 |
|            | `routes/SmearSession.tsx`                         | 作答頁                                                                | 422  |
|            | `routes/SmearResult.tsx`                          | 成績頁:主題拆分、逐題檢討、拼字/俗名                                    | 442  |
|            | `routes/SmearDx.tsx`                              | 診斷詳情(薄殼,內容在 `SmearDxPanel`)                                  | 211  |
| 前端元件   | `components/smear/StartDialog.tsx`                | 開場對話框:題數 / 模式 / 寫法 / 主題 / 題源                             | 397  |
|            | `components/smear/AnswerInput.tsx`                | 輸入框 + 提示鏈(主題 / 看選項 / 直接看答案)                             | 246  |
|            | `components/smear/GradeReveal.tsx`                | 四種判定的揭曉徽章(e-ink 用 ✓ ◐ ~ ✗ 承載語意)                          | 141  |
|            | `components/smear/SmearDxPanel.tsx`               | 詳解 / 個人筆記 / 討論 / 相似 四分頁;`/smear/dx/:id` 與作答揭曉後共用    | 886  |
|            | `components/smear/SmearImage.tsx`                 | 圖片 + 放大 + 複製圖片(`lib/copyImage.ts`,不能 async)                  | 188  |
|            | `components/smear/ReadingFramework.tsx`           | 「怎麼判讀?」通用骨架(依 qtype/topic,不揭曉答案;開關記 localStorage)   | 100  |
|            | `components/smear/SmearDashboard.tsx`             | 首頁「抹片」分頁                                                       | 226  |
|            | `components/smear/SubmitTab.tsx` / `AdminSubmissionQueue.tsx` | 投稿表單 / 管理員審核佇列                                   | 425 / 379 |
| 資料管線   | `scripts/smear/`                                  | 見 §7                                                                 | —    |
| 測試       | `worker/lib/smear-*.test.ts`                      | 純函式                                                                | 4 支 |
|            | `frontend/e2e/smear-practice.test.mjs`            | 12 條:複習全流程、看選項、全真零洩漏、`/smear/exam`、meta 防呆          | 1003 |
|            | `frontend/e2e/smear-answer-overflow.test.mjs`     | 320px 不橫向溢出                                                       | 111  |
|            | `eink.test.mjs` / `smoke.test.mjs` / `sw-guards.test.ts` | 既有防線各有 smear 條目                                          | —    |

模組總量約 10,400 行(含測試)。

---

## §5 端點與路由

三個 Hono router 都掛在 `/api/smear`(`worker/index.ts:145-147`),全部在
`authMiddleware` 之後,**全部不進 `sw-guards.ts` 的 `CACHEABLE_API`**(有測試釘著,
連看起來唯讀的 `/meta` 都不准:它跟著 `smear_dx` 匯入進度變)。

| 端點                                  | 用途                                            | 模式限制            |
| ------------------------------------- | ----------------------------------------------- | ------------------- |
| `GET  /meta`                          | topic 分布與比例(抽題與畫面共用同一支算法)        |                     |
| `POST /sessions`                      | 開場:抽題(最多 200)、存 `question_ids`           |                     |
| `GET  /sessions` · `GET /sessions/:id`| 作答記錄 / 單場(全真交卷前題目 id 是 `#idx`)      |                     |
| `POST /sessions/:id/answer`           | 判定;複習立即回 tier,全真只回「收到」             |                     |
| `POST /sessions/:id/mc-options`       | 看選項:5 個洗牌後的文字,不帶正解位置             | 複習限定,全真 403   |
| `POST /sessions/:id/finish`           | 交卷:總分、`spelling_ok`、`lay_count`、逐題揭曉   |                     |
| `GET  /wrong` · `GET /topic-stats`    | 錯題本(按 dx 聚合)/ 主題正確率                    |                     |
| `GET  /dx/:id` · `GET /search`        | 診斷詳情 / 獨立 FTS 搜尋                          |                     |
| `smear-terms`:4 個                    | `GET /terms/recent`、`POST /dx/:id/terms`、投票 POST/DELETE |            |
| `smear-community`:15 個              | 收藏 3、筆記 4、討論 3、投稿 5(`pending`/`approve`/`reject` 需 admin) |  |

前端路由(`App.tsx:312-320`;具體路徑排在 `/smear/dx/:id`、`/smear/s/:id` 之前):

| 路徑                      | 頁面                                                  |
| ------------------------- | ----------------------------------------------------- |
| `/smear?tab=`             | 練習 / 作答記錄 / 錯題本 / 搜尋 / 已收藏 / 投稿(六分頁,`KeepAlive`) |
| `/smear/review`           | 主題卡片 → 開 `StartDialog({initialMode:'review', initialTopics})` |
| `/smear/exam`             | 一段說明 + 一顆按鈕 → 開 `StartDialog({initialMode:'exam'})` |
| `/smear/s/:id`            | 作答頁;複習模式揭曉後直接嵌入 `SmearDxPanel`            |
| `/smear/s/:id/result`     | 成績頁;**未完成的全真直接導回作答頁**(#224 抓到的洩題)  |
| `/smear/dx/:id`           | 診斷詳情                                               |

入口:`config.toml [home] primary_mode = "smear"` 時,首頁預設開抹片分頁、手機底部
導覽四顆(複習 / 全真 / 搜尋 / 收藏)指向抹片。頂端導覽的「抹片」只在 `xl` 以上
出現(`App.tsx:229`),其餘寬度走「更多」下拉。

---

## §6 作答流程與防洩題

```
StartDialog ──POST /sessions──▶ smear_sessions(question_ids 固定)
   │
   ▼  /smear/s/:id
AnswerInput ──POST /answer──▶ gradeSmear() ──▶ smear_answers
   │  複習:回 tier/score/canonical → GradeReveal + SmearDxPanel
   │  全真:只回「收到」,題目 id 是 #idx
   ▼
POST /finish(全真)──▶ score / spelling_ok / lay_count ──▶ /result
```

**全真模式的四道閘**,每一道都是對抗性審查抓過真實漏洞後留下的:

| 閘                                   | 擋什麼                                                            | 出處  |
| ------------------------------------ | ----------------------------------------------------------------- | ----- |
| `clientQuestionId()` 回 `#idx`        | ASH 題的 id 內嵌 dx slug(`ash-hairy_cell_leukemia-63662`),原樣送出等於洩答 | #223  |
| `/answer` 只看 `session.mode`         | 不受 `hintUsed` / 空白輸入影響回應形狀                              | #225  |
| `/result` 未完成就導回                | 直接打網址會把沒答的題判 miss 並揭曉                                 | #224  |
| `/mc-options` 全真 403、面板 render-level 條件 | 全真作答全程**連 `GET /dx/:id` 都不打**                       | #228 / #234 |

e2e 的驗法是「交卷前整頁原始碼掃不到任何一個正解字串」,而且有一條**自我驗證**
(`若 exam 模式的 answer 回應意外帶了判定,畫面掃描要抓得到`)證明掃描器本身有效。
**新增任何複習限定的功能,都要補進這條掃描。**

提示鏈(複習限定,全部記進 `smear_answers.hint_used`,不影響分數):

| 提示            | `hint_used`      | 狀態                                                   |
| --------------- | ---------------- | ------------------------------------------------------ |
| 主題分類        | `topic`          | 有                                                     |
| 看選項(五選一)  | `mc_choice`      | 有(#234);正解文字來自 `pickCorrectOptionLabel()`,不是 `canonical_long` |
| 直接看答案      | `reveal_answer`  | 有(#225);送空字串走 miss                               |
| 首字母          | —                | 設計有、**沒做**                                        |
| 字數 / 逐字格   | —                | **刻意拿掉**:103 個診斷的題庫裡字數就是強線索(#224)      |

⚠️ 「用了幾次提示」「複習模式的拼字正確率」目前**沒有任何聚合**,只有逐列旗標。
哪天加了,那支查詢要排除 `hint_used = 'mc_choice'`(用選的沒有打字這回事)。

---

## §7 內容管線

```
~/Dropbox/血專大補丁/抹片考訊/     4 份答案卷 + 4 份投影片(203 題)      ┐
~/ash-image-bank/data/            6973 張 ASH 圖 + index.jsonl(WHO 階層) ┤ 都在 repo 外
                                                                          ┘
scripts/smear/
  parse_answers.py   答案卷 → raw-answers.json(main / alts / half)
  render_pages.py    投影片每頁 → trim 白邊 → WebP ×2(view 1600 / full 2400)
  normalize_prompt.md   subagent:203 題 → dx.json(canonical / full[] / half[] / lay[] / topic)
  note_prompt.md        subagent:103 份詳解初稿 → dx-notes.json(五段固定骨架)
  data/ash-map.json     每個 dx 最多 3 張 ASH 圖
  import.ts          上面全部 → R2 + D1(delete-then-insert)
```

```bash
pnpm smear:import            # local(預設)
pnpm smear:import --remote   # ⚠️ 會清掉 smear_sessions / smear_answers / smear_term_votes
```

- **答案卷 ↔ 投影片的對應要靠錨點題驗證**(Test-3 #18 是唯一的 A/B 雙標題),
  頁數對得上不等於對得對;錯位一格之後每題都錯,看起來像判定壞掉。
- **`normalizeTerm()` 只有一份**,`import.ts` 直接 import `worker/lib/smear-grade.ts`。
  匯入端與判定端各自一份的話,寫進 `norm` 欄的字串跟比對時算出來的會漂。
- **詳解的骨架固定五段**:一句話 / 怎麼認(#226 起開頭多一句英文形態描述)/
  容易混淆的(帶 `related_dx_ids` 連到別的 dx)/ 臨床脈絡 / 拼字提醒。
  詳解是離線 subagent 產的,**runtime 零 AI 呼叫**。
- **改詳解或詞表目前的路徑是改 `data/*.json` → 重跑 import**,不是站上編輯
  (`smear_dx_notes` 有鎖欄位但沒有 UI)。這跟 MCQ 詳解「站上共筆」的模型不同。

---

## §8 時間線

| 日期       | PR   | 內容                                                     |
| ---------- | ---- | -------------------------------------------------------- |
| 2026-09-03 | —    | 設計文件 + 17 個 task 的計畫                              |
| 2026-09-04 | #222 | Phase A+B:資料管線、migration 0043、`gradeSmear` / `pickSmearSet` |
| 2026-09-04 | #223 | Phase C:Worker API、提報投票(對抗性審查抓到 3 個洩題漏洞)  |
| 2026-09-04 | #224 | Phase D+E:前端(手機優先)+ 測試防線,`/smear` 對使用者可見   |
| 2026-09-05 | #225 | 複習模式「直接看答案」                                     |
| 2026-09-05 | #226 | 103 份詳解加英文形態描述句(兩輪醫學審核)                    |
| 2026-09-05 | #227 / #228 | 社群功能後端(migration 0044)/ 前端:收藏、筆記、討論、複製圖片、`SmearDxPanel` |
| 2026-09-05 | #229 | 投稿 + 管理員審核佇列(抓到「核准的投稿永遠抽不到」的 UI 缺口) |
| 2026-09-05 | #230 | 學習動線:判讀骨架、錯題聚焦、弱點主題再練                   |
| 2026-09-05 | #231 | 首頁改版,抹片成主力;`config.toml [home] primary_mode`      |
| 2026-09-05 | #232 | 複習/全真拆兩個入口,`/smear/review` 主題選擇頁、`/topic-stats` |
| 2026-09-06 | #234 | `/smear/exam` 真路由 + 看選項提示(parity 設計的 Layer 1 + 3) |

三天、12 個 PR、約一萬行。**節奏快,代表下一輪最值得做的是「用」而不是「加」。**

---

## §9 已決定的事與被否決的方案

下一輪規劃時**不要重新提議右欄的東西**,理由已經在原文裡寫過:

| 決定                                    | 被否決的方案                    | 為什麼                                                      | 出處        |
| --------------------------------------- | ------------------------------- | ----------------------------------------------------------- | ----------- |
| alias / 詳解掛 `dx_id`                   | 掛 `question_id`                | 同診斷多張圖,漏改一筆的症狀沒人回報得清楚                     | 設計 §資料模型 |
| 作答記錄自己一套表                       | 塞進 `attempts`                 | FK 指向 `questions`,動它等於讓每條既有查詢多想一次            | 設計        |
| 收藏 / 筆記 / 討論另開表                 | 重用 `personal_notes` / `comments` | 同一個 FK 問題;同 0040 自由筆記的解法                        | #227        |
| 單一輸入框                               | 逐字格(原設計)                  | 格數洩漏字數;手機沒有 Tab 鍵                                 | #224        |
| 不做字數提示                             | 字數 / 首字母提示鏈             | 同上;首字母只是還沒做                                        | #224、parity |
| `/smear/exam` 是落地頁 + 既有對話框       | 把 `StartDialog` 搬成頁面表單(A)/ 筆試改成對話框(B)/ 轉場確認框(C) | 跟 `/smear/review` 已確立的慣例一致、改動面積最小 | parity §Layer 1 |
| 看選項用獨立小元件                       | 重用 `QuestionCard` 的選項      | 那個元件綁死 MCQ 資料形狀(收藏 / 信心 / 管理員編輯)           | parity §Layer 3 |
| 干擾項沿用 `topic` + `qtype` 分層         | 新建相似度演算法                | 白血球自然混白血球;不為一個提示多養一套演算法                  | parity      |
| 看選項選對算全對                         | 打折扣分                        | 跟主題提示同一套誠實帳:分數不罰,統計頁另外揭露                 | parity      |
| 提報通過不追溯改分                       | 追溯重算                        | 成績頁的歷史數字會自己變;設計說改成檢討頁標「後來被接受了」,**那個標示還沒做**(§11) | 設計、`smear-proposal.ts` |
| 被否決的詞留墓碑                         | 刪列                            | 同一個詞會被反覆提報                                          | 0043 註解    |
| 不做 FSRS 排程                           | 間隔複習                        | 抹片是「掃過去找不熟的」;會長出對 `review_progress` 的依賴     | 設計 Non-goals |
| 不混進首頁熱力圖 / 弱點地圖               | 統一統計                        | 測的能力不同                                                 | 設計        |
| PO(PathologyOutlines)補充圖延後          | 第一版就抓                      | 要解上百個 slug + gentle scraper;對 RBC 形態幾乎沒覆蓋;schema 已留位置 | 設計 §分期 |
| 投稿核准後 `source='submission'` 進預設抽題池 | 另設「只練投稿」篩選         | 核准本身就是信任閘門                                          | `smear.ts` SOURCES 註解 |
| 詳解離線產、runtime 零 AI                | 請求路徑上呼叫 Workers AI       | 免費額度;而且詳解要固定骨架,不是自由散文                       | 設計 §成本   |
| Levenshtein 容錯只給 ≥5 字               | 全部開容錯                      | AML / ALL 距離正好是 1,題庫滿是三字母縮寫                     | `smear-grade.ts` 檔頭 |

---

## §10 已知地雷

- **`import.ts` 是 delete-then-insert,會清掉使用者資料。** 正式機一有真人紀錄就
  不能再跑 `--remote`。這是目前最大的營運風險(§11 第一項)。
- **`smear_questions.id` 內嵌 dx slug**(ASH 題),跟 0043 註解寫的純數字格式不符。
  任何把 id 送到前端的新端點都要走 `clientQuestionId()`。
- **`canonical_long` 常帶括號補充,`gradeSmear()` 只認 `smear_terms`。** 103 個
  診斷裡 19 個(18%)`canonical_long` 直接送進判定會是 miss。要顯示或送出「正解」
  一律用 `pickCorrectOptionLabel()` 那條路(#234 的 critical bug)。
- **一場最多 200 題,`IN (?,...)` 會撞 D1 參數上限**,`loadSessionQuestions()`
  已經 `chunkParams`;新的批次查詢要沿用。
- **`/api/smear/meta` 缺 `topics` 會讓整頁空白**,`StartDialog` 與 `SmearReview`
  各自防呆(#231、#232);新的入口也要各自防,不能只靠其中一個。
- **`copyImage.ts` 不能是 `async`**:Safari 要求 `ClipboardItem` 建構到
  `clipboard.write()` 之間留在使用者手勢的呼叫堆疊裡。
- **`/smear/dx/:id`、`/smear/s/:id` 是萬用參數路由**,新的固定路徑(`/smear/xxx`)
  要排在它們前面(`App.tsx` 有註解)。
- **FTS 是 `unicode61`**,中文詞只比得到連續 CJK 的開頭,同 MCQ 搜尋那節的限制。
- `aml_m2` 的詳解把 t(8;21) 跟 dysplastic eosinophil 寫在一起,#226 審核時判斷應為
  inv(16)/M4Eo 的特徵,**說要另開 issue 但沒有開**,中英文都還沒修。
- e-ink 掃描沒覆蓋「確認退件」子狀態(textarea + 確認鈕),#229 留的。
- `CLAUDE.md` 的「抹片 × 筆試操作一致性」那節引用「上面『抹片練習』那節」,
  **那一節不存在** —— 抹片練習從來沒有寫進 CLAUDE.md 設計筆記,只有 plan 檔。
  本文件補的就是這個洞。

---

## §11 已知缺口(設計有、程式沒有,或 PR 明說留給後續)

| 缺口                                          | 來源           | 大小 | 備註                                                        |
| --------------------------------------------- | -------------- | ---- | ----------------------------------------------------------- |
| **import 不能再對正式機重跑**                   | `import.ts` 檔頭 | M  | 改成內容表 upsert、不碰 `smear_sessions`/`answers`/`votes`;或拆成 `--content-only` |
| Layer 2:答後面板殼與 `Question.tsx` 分頁殼共用   | parity 設計     | L    | 方向定了,props 介面與階梯斷點沒設計                            |
| 手把 / 全站鍵盤系統整合                          | parity、#234    | L    | 目前只有原生 radio 的方向鍵                                    |
| 首字母提示                                      | 設計 §兩種模式  | S    | 加一種 `hint_used` 值 + 一顆按鈕                               |
| 提示使用率 / 複習模式拼字正確率聚合               | parity §計分    | S–M  | 要排除 `mc_choice`                                            |
| 詳解站上共筆編輯                                | 0043 有鎖欄位   | M    | 現在改詳解只能改 JSON 重跑 import;跟上一項衝突,要先解 import   |
| 個人筆記拖曳排序                                | #227 YAGNI      | S    | 表有 `sort_order`;可抄 `personal_notes` 那套 `reorder.ts`     |
| 討論串 @mention 與通知                          | #227            | M    | `smear_comments` 沒有 mentions 路徑                            |
| PathologyOutlines 補充圖                        | 設計 §分期      | L    | gentle scraper,對 RBC 形態幾乎沒覆蓋                          |
| 投稿核准後沒有 view/full 兩種尺寸                | `approve()` 註解 | S    | v1 簡化:`image_key_view` / `image_key_full` 指向同一把 key,不做伺服器端二次裁切 |
| 提報通過後「你當時寫的 X 後來被接受了」的追溯標示   | 設計、`smear-proposal.ts` 檔頭 | S | **只在註解裡**,`SmearResult.tsx` 沒有查 `smear_terms` 的後續狀態 |
| `aml_m2` 詳解錯誤                               | #226            | S    | 開 issue、改 `dx-notes.json`、重灌(又撞 import 問題)          |
| e-ink 退件子狀態掃描                            | #229            | S    |                                                             |
| 提報投票流程從沒被真人走過                       | §2              | —    | 門檻 3 票對 20 人合不合適,要看數字                             |

---

## §12 下一輪規劃的建議順序

按「改動成本 × 使用者撞到的頻率」(parity 設計用的同一把尺):

1. **先解 import 的破壞性**(§11 第一項)。這不是功能,是讓其他每一項變得可做的
   前提:詳解修錯、詞表補詞、`aml_m2`、PO 補圖全部要重灌,而重灌現在會洗掉紀錄。
   做法上把「內容表」(`dx` / `terms` / `questions` / `dx_notes` / `fts`)與
   「使用者表」分開,內容走 upsert,使用者表不碰;`smear_terms` 要保住社群提報進來
   的列(`proposed_by IS NOT NULL` 的不覆蓋)。
2. **讓人真的用一週,看三個數字**:`hint_used` 分布(提示鏈哪一層有人用)、
   `lay` 比例(俗名層的價值有沒有兌現)、`infection` 這種小 topic 的抽題體感。
   這一步不寫程式。
3. **小而確定的收尾**:首字母提示、`aml_m2`、e-ink 退件掃描、筆記拖曳。各半天內。
4. **Layer 2 面板殼共用**:只有在(2)證明「答後面板」是高頻路徑之後才值得做,
   否則是為了對稱而對稱。
5. **手把整合**與 **PO 補圖**:都是 L,而且各自依賴上面的結果(手把要 Layer 2 的
   情境判斷;PO 要 import 可重跑)。

---

## §13 驗證與查詢速查

```bash
# 純函式 + e2e
pnpm test                                                   # 含 worker/lib/smear-*.test.ts
node --test frontend/e2e/smear-practice.test.mjs frontend/e2e/smear-answer-overflow.test.mjs
# (e2e 要先 pnpm --dir frontend build;fixture 在 frontend/e2e/fixtures/smear_*.json)

# 題庫概況(local 換 --local)
DB=$(node scripts/lib/cfg.mjs project.d1_db)
wrangler d1 execute "$DB" --remote --command "SELECT source, COUNT(*) FROM smear_questions GROUP BY source"
wrangler d1 execute "$DB" --remote --command "SELECT topic, COUNT(*) FROM smear_dx GROUP BY topic"
wrangler d1 execute "$DB" --remote --command "SELECT status, tier, COUNT(*) FROM smear_terms GROUP BY status, tier"
# 有沒有人在用
wrangler d1 execute "$DB" --remote --command "SELECT mode, COUNT(*), SUM(finished_at IS NOT NULL) FROM smear_sessions GROUP BY mode"
wrangler d1 execute "$DB" --remote --command "SELECT hint_used, COUNT(*) FROM smear_answers GROUP BY hint_used"
# 一個診斷的全部
wrangler d1 execute "$DB" --remote --command "SELECT d.*, (SELECT group_concat(text||':'||tier, ' | ') FROM smear_terms WHERE dx_id=d.id AND status='accepted') terms FROM smear_dx d WHERE id='dacrocyte'"
```

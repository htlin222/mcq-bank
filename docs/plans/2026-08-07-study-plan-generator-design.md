# 讀書計畫產生器:對話式問卷 → HTML / ICS

2026-08-07

首頁倒數卡片右側加一個入口,問七題,產出一份到考試當天的逐日讀書計畫表
(單檔 HTML)與一份可匯入行事曆的 `.ics`。

結論先講:**這個功能最有價值的輸出不是那張漂亮的表,是「以你給的時間,到考前
差 137 題」這一句話。** 排版可以樂觀,數字不行 —— 所有排程一律由決定性的純函式
算出,Workers AI 只負責把弱點診斷寫成人話。

## 為什麼不是既有的 PacingCard

`PacingCard`(`docs/plans/2026-07-20-study-goals-and-pacing.md`)回答的是「以我
**目前**的速度,考前做得完嗎」—— 它是後視鏡,輸入全部來自 `attempts` 的既成事實。

這裡回答的是另一個問題:「我**打算**每天投入 90 分鐘、只寫 114 到 110 五年、
想跑兩輪、考前排四場全真 —— 這樣排得出來嗎,每天長什麼樣?」輸入是使用者的
意圖,不是歷史。兩張卡的數字會並存,所以**天數一律取 `/api/review/readiness`
的 `days_left`**(對毫秒差 ceil),不混用首頁倒數卡的 `countdown.days`(floor)
—— 兩者差一天,同一畫面出現兩個天數是體感 bug。

## 入口

按鈕放在倒數卡片**內部**、靠右。那個容器是 `flex items-baseline gap-x-3
flex-wrap`,所以按鈕用 `ml-auto self-center`:靠 `ml-auto` 推到右緣,靠
`self-center` 脫離 baseline —— 跟 `text-3xl` 的天數對 baseline 會明顯錯位。
手機上 `flex-wrap` 讓它自己落到第二排右側,不擠壓倒數數字。

樣式走 ghost(文字 `text-accent`,邊框 hover 才出現)。那張卡已經有 accent 底色,
再放一顆實心鈕會打架。`finished`(考試已開始)時不顯示。

## 對話 UI

新元件 `frontend/src/components/StudyPlanDialog.tsx`,沿用 `ExportDialog.tsx`
的 modal 骨架(`fixed inset-0` + backdrop)。

專案沒有 shadcn / Radix,message-scroller 那種「訊息一則一則往下長」的感覺自己
刻:一個 `overflow-y-auto` 容器,每答完一題 append 兩則(系統提問 + 使用者答案
的回顯),新訊息 `scrollIntoView({ block: 'end' })`。回答用選項 chip 為主、數字
輸入為輔,**不做自由文字** —— 七個答案全部要能餵進純函式,自由文字只會製造解析
問題。已回答的訊息可點回去改,改了就截斷後面重問。

三個階段:問答 → 預覽 → 下載。

## 問卷七題

每題都用實際數據預填成預設值,使用者只需要改動不符的部分。

| # | 問題 | 預設值來源 |
|---|------|-----------|
| 1 | 目前進度 | `/api/review/readiness` 的 `completed / total`,可改(線下寫過但沒登錄) |
| 2 | 要寫哪幾年 | 年份 chip 多選,預設全選;每個 chip 顯示該年未完成題數 |
| 3 | 每天可投入時間 | 30 / 60 / 90 / 120 分鐘或自填 |
| 4 | 每題平均秒數 | 該使用者 `attempts.elapsed_ms` 的中位數,無資料則 90 秒 |
| 5 | 要跑幾輪 | 1 / 2 / 3,預設 2 |
| 6 | 全真模擬幾場 | 0–6,預設「考前四週每週一場」 |
| 7 | 讀書時段 | 幾點到幾點,只給 `.ics` 用 |

第 3 題 × 第 4 題才是每日題數上限。分開問而不是直接問「每天幾題」,因為使用者
知道自己有多少時間,但通常高估自己的速度 —— 第 4 題用實測中位數預填就是在把這
個高估攤開來給他看。

## 排程演算法

`worker/lib/study-plan.ts`,純函式。吃 `PlanInput`(七題答案)+ `PlanContext`
(D1 撈的進度快照),吐 `PlanResult`。不碰 D1、不碰 `Date.now()`(時間由呼叫端
注入),所以 `pnpm test` 就能整支測完。

**容量**:`每日題數 = floor(每日分鐘 × 60 / 每題秒數)`。

**需求**:

- 第一輪 = 選定年份的未完成題數
- 第 N 輪(N ≥ 2)= **只排錯題**,不是重跑全題

第二輪起只排錯題是刻意的。若每輪都排全題,「剩 28 天要跑兩輪 1000 題」會直接
算出一天 71 題的計畫 —— 那不是計畫,是一張使用者看一眼就關掉的表。錯題數用該
使用者的實測正確率推估(無資料用 0.35)。

**填日曆**:需求逐日填進「明天到考試前一天」。週日留白當緩衝(可關)。全真模擬
各佔一整天(100 題),當天不排日常題目。

**排不完就說排不完。** `PlanResult.shortfall` 帶著差額回傳,dialog 直接顯示
「以這個速度到考前差 N 題」,並給三顆一鍵重算的按鈕:每天加 M 題 / 砍掉最舊的
年份 / 改成少一輪。這句話不能被樂觀的排版蓋掉 —— 它是使用者現在就該做決定的
唯一理由。

文案立場沿用 `PacingCard`:不用紅色、不用警告語彙、落後時給的是下一步而不是
「你落後了」。

## 弱點資料 + AI 導讀

**弱點怎麼算(規則式,在 AI 之前)。** 不用 `/api/review/weakness-map` ——
它依賴 Vectorize 索引,目前未回填時直接回空陣列,拿它當計畫基礎會在多數使用者
身上開天窗。改用兩張確定性的表:

1. 逐年正確率:`attempts` join `questions` group by year
2. 逐主題正確率:`question_tags`,但**只取 `scripts/video-topics.json` 白名單
   內的主題**。那 853 個自由標籤已經被正規化合併過一次,直接 group by raw tag
   會得到一堆噪音(策展影片踩過這個坑)。同時濾掉作答數 < 8 題的主題 ——
   「1 題錯 1 題 = 0%」變成頭號弱點是統計雜訊,不是弱點。

**AI 只負責語氣,不負責結論。** 逐日題數、日期、輪次、shortfall 全由純函式算。
LLM 做加法會錯,而錯的計畫表比沒有計畫表更糟。

合約:

- 輸入 = 最多 12 列的「主題 / 正確率 / 作答數」表 + 剩餘天數。**不含題目內容、
  不含 email**
- 輸出 = 3–4 句繁體中文,寫進計畫表最上方
- prompt 明講:不要出現表格以外的推論、不要編造題數、不要鼓勵性廢話
- 限長 400 字,`Promise.race` 加 6 秒 timeout
- 逾時或 `AiError` → 整段省略,計畫表照出

模型走 `worker/lib/ai-models.ts` 的 `TEXT_MODEL`,不寫死 model id —— 上次
`llama-3.1-8b-instruct` 被 deprecate(AiError 5028)時,是靜默地弄壞了每一個 AI
端點。

一次生成 = 1 次 LLM 呼叫。20 人 × 每人每週幾次,離 free tier 10K neurons/天
很遠。

## 輸出

### HTML

`worker/lib/study-plan-html.ts` 產單檔 HTML,inline CSS,跟 `export-html.ts`
一樣不依賴任何外部資源。內含 `@media print` 分頁規則(每週不跨頁)與一顆
「列印 / 存成 PDF」按鈕(`window.print()`,`@media print` 時自己隱藏)。

**真 PDF 是 non-goal。** Cloudflare Browser Rendering 要付費;純 JS 的 pdf-lib
要印中文得嵌 CJK 字型(Noto Sans TC 完整檔約 10MB,超過 Worker bundle 上限),
改成從 R2 拉字型再 subset 則 free plan 每請求 10ms CPU 撐不住。瀏覽器列印的
輸出品質跟真 PDF 沒有差別,成本是零。`export.ts` 早已把 PDF 列為 non-goal,
這裡沿用同一個結論。

### ICS

`worker/lib/study-plan-ics.ts`:

- 每日一個 `VEVENT`,`DTSTART`/`DTEND` 取問卷第 7 題的時段,配
  `TZID=Asia/Taipei`
- `SUMMARY` 寫具體任務:`114-021~114-050 共 30 題`
- `UID` = `plan-{email 的 hash}-{date}@<host>`,保證重複匯入是**更新**而非疊加
  出第二份
- 全真模擬日、考試當天各一個獨立事件

選定時事件而非 all-day,是因為手機只有定時事件才會跳提醒 —— all-day 的計畫表
不會被執行。

## API

`worker/routes/study-plan.ts`:

- `POST /api/study-plan/preview` → `PlanResult` JSON,dialog 即時預覽,改參數
  就重打
- `POST /api/study-plan/export?format=html|ics` → 可下載的檔案
- `GET` / `PUT /api/study-plan` → 讀寫使用者上次的問卷輸入

前端**不重算排程**,只顯示 Worker 回的結果。兩邊各算一次必然會在某個邊界條件
上算出不同數字。

全部 per-user(`c.var.email`),不接受 email 參數。

## 資料模型

`migrations/0039_study_plans.sql`:

```sql
CREATE TABLE study_plans (
  user_email TEXT PRIMARY KEY,
  input_json TEXT NOT NULL,   -- 問卷七題的答案
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

一人一列,**只存輸入不存排程結果**。理由跟 `review_progress` 那條規則同源:
排程是可從「輸入 + 當下進度」重算的衍生值,存下來就會跟真實進度漂移,而漂移的
計畫表沒人會發現它錯了。下次開對話直接預填上次答案,按「重新產生」就是拿今天的
進度重算。

## Service Worker

**`/api/study-plan` 不加進 `sw-guards.ts` 的 `CACHEABLE_API`。** 它是可變狀態,
被快取住會讓使用者看到上一版的計畫還以為沒存到。`sw.ts` 一行不動。

## 測試

- `worker/lib/study-plan.test.ts` —— 容量計算、多輪遞減、shortfall、週日留白、
  年份全選/單選、零進度新使用者、考試已過期(`days_left <= 0` 要回明確的空計畫
  而不是負數迴圈)
- `worker/lib/study-plan-ics.test.ts` —— `VCALENDAR` 結構、事件不重疊、UID 穩定
- `frontend/e2e/` 加 `study-plan` fixture 與一條 WebKit 煙霧測試。這個 dialog
  會在 iOS 上被開,而 `frontend/e2e` 存在的理由就是 Chromium 綠燈不算數
  (2026-07-29 的 iOS 白屏)

## Non-goals

- 真 PDF(見上)
- 多份計畫版本 / 歷史
- 首頁的每日任務勾選與達成率 —— 與 `PacingCard` 重疊,且會把一個一次性的產生器
  變成一個有狀態機的功能
- 把計畫分享給其他使用者
- AI 決定讀書順序 —— 每次生成結果不一樣的計畫表沒有信任基礎

## 交付順序

1. `worker/lib/study-plan.ts` + 測試(純函式先行,排程對了其他都是包裝)
2. migration `0039` + `worker/routes/study-plan.ts`
3. `StudyPlanDialog.tsx` + 倒數卡片入口
4. HTML / ICS renderer
5. AI 弱點導讀(最後 —— 它是可省略的那層,前四步先能獨立跑完)
6. WebKit 煙霧測試

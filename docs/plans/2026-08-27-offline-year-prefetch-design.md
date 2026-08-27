# 離線預載一年的題目

進入 `/year/:y` 時,在背景把那一年 100 題的 payload 抓進 Service Worker 快取,
讓使用者之後離線也讀得到。**只做文字,圖片二期**(見最後一節)。

## 先講量到的數字

全部從本機 D1(1100 題,與正式機同步)與 R2 抽樣量出來的:

| 一年(100 題) | 大小 | 請求數 |
| --- | --- | --- |
| 題目(stem + options) | 38–66 KB | 1(`/api/questions?year=X&limit=200`) |
| 共筆詳解 | 119–344 KB | 100(`/api/questions/:id`) |
| 圖片 | 8–17 MB | 125–259 |

- 圖片抽樣 10 張,平均 **66 KB**。
- **全部 11 年的文字加起來只有 2.4 MB。** 文字不是成本,圖片才是 —— 差 40 倍。
  這就是「先只做文字」的全部理由:它幾乎免費,而免費的東西不需要問使用者要不要。

## 兩個原本以為要設計、量完發現不必做的東西

這一節比其他任何一節都重要 —— 它記的是**沒有做什麼,以及為什麼**。

### 不做批次端點(`/api/questions/bulk?year=X`)

原本的直覺是「100 趟請求太多,做一個端點一次回整年」。`/api/questions/:id` 是九個
查詢併一趟(`Promise.all`)組出來的,批次版可以把它們改寫成 per-year 的聚合查詢
—— 900 個查詢變 9 個,聽起來像 100 倍的勝利。

**量完之後那個勝利不存在。** 相關的表全都有索引,而且資料量極小:

```
explanations       sqlite_autoindex_explanations_1
question_tags      idx_tags_tag, idx_tags_question
review_progress    idx_rp_user, idx_rp_question
bookmark_items     idx_bi_user, idx_bi_folder
personal_notes     idx_notes_by_user, idx_notes_order
question_refs      idx_refs_by_target        ← 全表 0 列
comments           idx_c_question            ← 全表 27 列
```

一題的 payload 大約讀 **10 列**,一年 100 題約 **1,000 列**。D1 free tier 是每天
500 萬列 —— 20 個人每天各拓三年,也才 6 萬列。**這條路上沒有瓶頸可以優化。**

而批次端點的代價是真的:**它會是第二份組 payload 的程式碼**。單題版回的是 12 個
欄位,其中 5 個帶 `email`(作答進度、收藏、個人筆記、進行中的挑戰、留言數),還有
`my_note = notes[0]`、`personal_notes` 的 `ORDER BY sort_order, slot`、
`back_refs` 那個 `CASE` join 這種一不小心就抄漏的細節。抄漏的症狀是
**「離線看某一題少了一塊東西,線上看正常」** —— 而這個 repo 沒有 route 層的測試
(`worker/**/*.test.ts` 全部是純函式),所以那種漂移沒有任何一道自動防線接得住。

**用 100 趟同一個端點的請求,換掉一整類查不到的 bug。** 這筆交易很划算。

> 如果哪天真的需要批次(例如二期把圖片也算進來、或題庫長到 5000 題),前提是先把
> `buildQuestionPayload()` 抽成純函式讓兩邊共用,並且為它補測試。**在那之前不要
> 開這個端點。**

### 不開第二個快取(`offline-year-v1`)

原本的設計是「使用者明確下載的一年」不該跟「順手快取」混在一起,因為
`api-json-v1` 上掛著 `maxEntries: 400` + `maxAgeSeconds: 7 天` 的 LRU,隨時會把
下載好的年份無聲吃掉。於是要開第二個 cache,再讓 SW 的 `handlerDidError` 去那裡
找 —— 一整套驅逐策略。

**但這個問題的前提不成立:題庫是有界的,而且很小。**

- 全部 1100 題,以 JSON 計約 **4.4 MB**。
- 把 `maxEntries` 從 400 提到 **1500**,就大於題庫的全部題數。

`1500 > 1100` 之後,**驅逐壓力整個消失** —— 沒有「刻意下載的 vs 隨手看的」要區分,
因為兩者都放得下。那個要設計的策略,連同它的 SW fallback 路由、cache 命名、清除
UI,全部一起消失。**這不是把問題解決掉,是讓它不存在。**

所以這一項的改動只有兩個數字:

```diff
- new ExpirationPlugin({ maxEntries: 400, maxAgeSeconds: 7 * 24 * 60 * 60 })
+ new ExpirationPlugin({ maxEntries: 1500, maxAgeSeconds: 90 * 24 * 60 * 60 })
```

**7 天那個上限一定要一起改**,不然拓好的一年**第 8 天無聲過期** —— 考前兩週拓好,
考當天打開是空的。代價是 NetworkFirst 的 3 秒 timeout 落回快取時,拿到的可能是
更舊的共筆詳解;但詳解本來就很少改,而 6 天前的版本跟 60 天前的版本在這件事上
沒有量級差別。

⚠️ **順手記一筆:`API_CACHE_NAME` 目前是個死的 export。** `sw-guards.ts` 的註解說
「頁面也會寫入這個快取(答題後推一份正確的 payload 進去)」,但全 repo 只有
`sw-guards.ts` 自己提到它,`sw.ts` 用的是字面量 `'api-json-v1'`。那條路徑應該是在
改成 `lib/questionProgress.ts` 的 `preserveLocalAnswer` 時被移掉、註解留著了。
這次一併清掉,否則下一個人會照著那段註解去設計「頁面寫快取」的方案(我就差點)。

## 要做的東西

### 觸發

`/year/:y` 的清單渲染完之後,在 `requestIdleCallback` 裡開始。**不擋畫面,也不跟
使用者正在讀的那一題搶頻寬。**

三道閘,每一道擋掉一種讓人生氣的情況:

| 閘 | 擋的是 |
| --- | --- |
| `navigator.connection?.saveData` | 使用者明講了要省流量,那就別自作主張 |
| 同一年 24 小時內拓過(localStorage 時間戳) | 一天內來回進出年份頁,每次重拓 100 趟 |
| 元件卸載 → `AbortController.abort()` | 使用者只是路過,拓到一半就該停 |

並行度 **4**。不設上限的話 100 個請求會同時擠出去,把使用者真正想開的那一題排到
後面 —— 那正是這個功能要避免的事。

### **不要**沿用 `questionStore.prefetch()`

它看起來剛好就是要的東西,但三個地方都不對:

- **TTL 是 60 秒。** 那是「換題預抓」的正確horizon,不是「拓一整年」的 ——
  兩分鐘後再進同一個年份頁,100 趟會整批重來。
- **記憶體 LRU 只有 40 筆。** 拓 100 題會把它洗過兩遍半,把使用者剛才在讀的那幾題
  擠掉。
- **沒有並行度上限。** 見上。

年份預載自己發 `fetch()`(走 `lib/api.ts`,所以 SW 照樣攔得到並寫進快取),
**刻意不碰記憶體 store** —— `Question.tsx` 本來就會預抓鄰居題,那一層不需要幫忙。

### 使用者看得到的狀態

自動 + 無聲 = **使用者不知道現在能不能離線**,而那正是他要這個功能的唯一原因
(通勤、地下室、醫院沒訊號的角落)。年份頁標題旁一個小 chip:

- 拓的過程:`離線備用中… 37/100`
- 完成:`✓ 可離線閱讀`
- `saveData` 或失敗:不顯示(不要為了一個使用者沒要求的背景行為製造焦慮)

判斷「這一年拓完了沒」不要另外記帳 —— 直接問
`caches.open('api-json-v1')` 裡有幾筆該年的 key。**記帳一定會跟真實快取漂移**
(使用者清過站台資料、SW 換版、配額不足被丟掉),而漂移的症狀是「顯示可離線,
實際打不開」—— 比不顯示更糟。

## 這樣做完之後,離線**還是**不能用的東西

一定要寫下來,不然使用者會以為「拓好了就什麼都能用」:

- **`/api/review/due/next`(到期佇列)** —— FSRS 排程,`sw-guards.ts` 刻意排除,
  也應該繼續排除。所以離線走得通的是 **`/year/:y` → 點題目 → 讀 → 作答**,
  不是複習模式的到期佇列。
- **討論串** —— `/api/questions/:id/comments` 是可快取的,但**不預抓**。理由同
  CLAUDE.md 那條「刻意不預抓鄰居題的留言」:多數人根本不會打開討論串,而那是
  再一百趟請求。點開過的那些會自然留在快取裡。
- **圖片** —— 二期。

作答本身**可以**離線:`lib/attemptOutbox.ts` 已經在了(2026-08-09 e-ink 上四題
靜默遺失那次做的),回線上會自動補送,而 `/api/review/answer` 帶 idempotency key,
重送不會多算。

> CLAUDE.md 的 PWA 那節現在寫著「There is no offline write path — no outbox」,
> **那句已經過時**,`attemptOutbox.ts` 的檔頭自己就這麼說。這次一併更正。

## 二期:圖片

介面留在同一個地方 —— 預載器走訪 `explanation.content_json` 撈 `/img/` 開頭的
URL 再 fetch 一次,SW 的 `img-v1` 路由(CacheFirst)自動收下。

二期真正要決定的是**成本怎麼呈現**,不是怎麼實作:

- 一年 **8–17 MB**,`img-v1` 的 `maxEntries: 300` 只裝得下**一年** ——
  拓第二年會把第一年的圖擠掉,而症狀是「離線看某些題沒圖」。要一起提高。
- 那個量級**不該自動拓**。按鈕上要先寫「114 年:約 12 MB」,並用
  `navigator.storage.estimate()` 檢查剩餘空間。
- 血液抹片、免疫染色本來就是要學的診斷資訊,所以「不下載圖」不是省事,是真的
  少了東西 —— 這也是為什麼它值得一個明確的按鈕,而不是默默跳過。

## 驗證

| 層 | 驗什麼 |
| --- | --- |
| `lib/yearPrefetch.test.ts`(純函式) | 並行度、24 小時去重、`saveData` 判斷、abort |
| `lib/sw-guards.test.ts` | 新的 maxEntries / maxAge;`/api/review/*` 仍然不可快取 |
| `e2e/offline-year.test.mjs` | 進年份頁 → 等拓完 → `ctx.setOffline(true)` → 開一題,**題幹與詳解都要在** |

⚠️ e2e 那支的正面對照組:**先斷言離線時開一題「沒拓過的年份」會失敗**。少了它,
「離線打得開」在 SW 根本沒攔截、請求其實走到 fixture 伺服器時也會成立 ——
又是一個空掃的綠燈(同 `note-swipe` 那三條負面斷言的教訓)。

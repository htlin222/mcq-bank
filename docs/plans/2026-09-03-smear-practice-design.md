# 抹片練習 (Smear Practice) 設計

2026-09-03

血液抹片判讀的填空式練習。跟現有 MCQ 題庫**完全分開**:自己的題庫、自己的
作答記錄、自己的搜尋。理由是這兩件事測的能力不同 —— MCQ 測「五選一認得出
來」,抹片測「看著圖把診斷**拼寫**出來」,而後者正是真實考卷要的。

## 為什麼要有這個功能

專科考試的抹片題是**填空**,不是選擇。認得出 dacrocyte 但寫成 `dacrocite`
在考卷上是 0 分,而現有的 MCQ 題庫完全練不到這一層。目標是把「所有考過的
抹片題」都練到**能正確拼出來**。

## 素材

### 考古題(主體,203 題)

`~/Dropbox/血專大補丁/抹片考訊/`:

| 答案卷 | 題數 | 對應投影片 | 頁數 |
| --- | --- | --- | --- |
| `Test-1-ANS.pdf` | 52 | `pre-test-A-2026.pdf` | 52 |
| `Test-2-ANS.pdf` | 50 | `pre-test-2.pdf`(Week 10) | 50 |
| `Test-3-ANS.pdf` | 50 | `wk-11-test.pdf`(Week 11) | 50 |
| `Test-4-ANS.pdf` | 51 | `week12.pdf`(Week 12) | 51 |

⚠️ **頁數對得上不等於對應是對的。** 建題庫時要用**可辨識的錨點題**驗證,
不能只靠題數。現成的錨點:Test-3 #18 是全部 203 題裡唯一的
「A = lymphocytes, CLL ; B = monocytes」雙標題,而 `wk-11-test.pdf` 也只有
一頁寫著 `What is the diagnosis? A and B?` —— 那一頁必須是第 18 頁。
**對應錯位的症狀是「答案看起來都很像但就是不對」**,而且錯位一格之後每一題
都錯,查起來會以為是判定邏輯壞掉。

另有 `20250313~20250702_血液_Smear-1~5.pdf` 五份徐千富老師的教學講義 ——
**不是考題**,但可以當詳解素材。

### ASH Image Bank(~300 題)

`~/ash-image-bank/data/` 已離線抓好 6973 張圖,`index.jsonl` 帶完整 WHO
階層分類(`Myeloid Neoplasms > AML > ... > AML with t(15;17)`)。

### PathologyOutlines(數量待估)

⚠️ **`search-results?q=` 抓不到。** 那頁是 Google CSE
(`cse.google.com/cse.js?cx=partner-pub-3521518608648020`),結果 client-side
render,`curl` 只拿得到導覽列。**要走 `/topic/<slug>.html`** —— 那些是靜態
HTML(實測 `hairycell.html` 解析得到)。

⚠️ **而且它會擋。** 連續三次請求就開始回 429(body 仍是一頁看起來正常的
HTML,`<title>` 甚至還是對的 —— 只有 status code 說了實話)。所以抓取要
**沿用 `~/ash-image-bank/scrape.py` 那套 gentle scraper**:循序、隨機 4–8 秒
停頓、429 指數退避、可續跑。

⚠️ **PO 是組織切片為主,我們考的是抹片。** `CML` / `hairy cell` / `Gaucher` /
`metastatic cancer` / `MDS` 會有用;`dacrocyte` / `target cell` /
`Howell-Jolly body` 這種純 RBC 形態幾乎沒有。所以每個診斷記一個**補充圖來源
優先序,抓不到就是抓不到,不硬湊** —— 硬湊的代價是複習模式跳出一張不是抹片
的切片圖,而使用者會以為自己判讀錯了。

## 答案判定

### 四層,不是一個字串

這是整個功能的核心,而**答案卷的原文不等於標準答案**。

| 層 | 例(Test-2 #9) | 分數 | 回饋 |
| --- | --- | --- | --- |
| `canonical_long` | `dacrocyte` | 1 | — |
| `canonical_abbrev` | (無) | 1 | — |
| `full` | `dacryocyte` | 1 | — |
| `half` | `poikilocytosis` | 0.5 | 「方向對,但不夠精準」 |
| `lay` | `tear drop` / `teardrop RBC` | **0** | 「你寫的是俗名,考卷要的是 **dacrocyte**」 |

`lay`(俗名)這一層是這個功能跟「隨便一個填空題」的差別。答案卷裡俗名不少:
`Teardrop RBC`、`Burr cell`、`Bite cell`、`Target cell`、`Rouleau formation`、
`Smudge cell`。**不給分,但要明確講出正解** —— 跟「完全不會」區分開來,並
單獨統計「用了幾次俗名」。

答案卷另有 2 題自己標了「半對」(`Plasmoblast (Plasma cell 半對)`),那是
`half` 這一層的來源。

### 格子數

**開場 dialog 全域選一次**(全稱 / 縮寫 / 任意),不是逐題切換。
格子數 = 該模式下 canonical 的字數:

- 全稱模式 `MAHA` → 3 格(`Microangiopathic` `hemolytic` `anemia`)
- 縮寫模式 → 1 格
- 沒有縮寫的題(`Mitosis`)在縮寫模式下 **fallback 用全稱**

⚠️ **格子數只是提示,不是硬閘。** 判定時把所有格子 join 成一句,再去比對
**所有** accepted 寫法(不分字數)。全稱模式下有人第一格打 `AML`,那是正確
答案,不該因為「你只填了 1/3 格」判錯。**強制字數的代價是誤傷真的會的人。**

### 判定純函式 `gradeSmear()`

1. **正規化** —— 小寫、去變音符(`Döhle` → `dohle`、`Pelger-Huët` →
   `pelger-huet`)、連字號/撇號/空白統一、去尾標點
2. **依 `full` → `half` → `lay` 順序**比對
3. 每層內逐字 Levenshtein ≤ 1 命中,但回傳
   `spellingErrors: [{typed, expected}]`
4. 回傳 `{tier, score, spellingErrors, canonical}`

⚠️ **tier 的比對順序是承重的。** `lay` 排在 `full` 之後 —— 反過來的話
`tear drop` 會被某個寬鬆規則先吃掉,而症狀是「這個功能好像不太在意我寫什麼」。
有一條測試專門釘這個順序。

**拼字錯不扣分,另計「拼字正確率」。** 分數回答「你認不認得這張圖」,拼字
正確率回答「你寫不寫得出來」—— 兩個是不同的能力,擠在同一個數字裡兩個都
看不清楚。

## 資料模型

**alias 掛「診斷」,不掛「題目」。**

```
smear_dx          一個診斷    canonical_long / canonical_abbrev / topic
  ├ smear_terms     可接受寫法  text / tier(full|half|lay) / form(long|abbrev) / status
  ├ smear_dx_notes  共筆詳解    content_json (TipTap) / version / editing_by
  └ smear_questions 一張圖      dx_id / source / image_key / prompt / qtype / attribution
```

⚠️ **掛在 `question_id` 上是錯的。** 同一個 `dacrocyte` 會有考古題 1 張 +
ASH 3 張 = 4 題;alias 掛題目的話,新增一個「`dacryocyte` 也算對」要改 4 筆,
而**漏改的那一筆症狀是「同一個答案,這張圖算我對、那張圖算我錯」** ——
沒有人會回報得清楚。

**詳解同理掛 `dx`。** 500 張圖不需要 500 份詳解,需要的是約 100 份
「這個診斷在抹片上怎麼認」。圖本身的箭頭/A-B 標註走 `smear_questions` 上一個
簡短的 `image_note`。

### 作答記錄:完全獨立於 `attempts`

`attempts.question_id` 有 FK 指向 `questions`,而抹片題不在那張表裡。動那個
FK 去塞一個不同種類的東西,等於讓 `attempts` 的每一條既有查詢都要多想一次。

```
smear_sessions(id, user_email, mode, config_json, started_at,
               finished_at, duration_sec, score, spelling_rate)
smear_answers(session_id, question_id, typed_json, tier, score,
              spelling_errors_json, hint_used, answered_at)
```

**錯題本從 `smear_answers` 推導,不另存一張表** —— 另存一張就會漂移,而漂移
的症狀是「錯題本裡有我早就答對的題」。同 `review_progress` 是快取、
`attempts` 才是真相那條規則。

首頁熱力圖、弱點地圖、成績頁一律**不混入**抹片。

## 出題

**分層抽樣,不是先隨機再檢查。** 比例由 build script 從實際題庫**算出來寫進
DB**,不寫死在程式裡 —— 題庫之後會長大,寫死的比例會靜靜過期。

軸是**主題分類**(髓系腫瘤 / 淋巴系 / 正常與反應性細胞 / 紅血球形態 /
血小板 / 感染寄生蟲 / 儲積症與其他)。

`pickSmearSet()`(純函式,rng 由呼叫端注入所以測得動):

1. 每類名額 = `round(N × 該類比例)`,用 **largest remainder** 補足到剛好 N
2. 類內隨機抽
3. ⚠️ **某類題數不足名額時,缺額按比例回填給其他類** —— 題庫小的時候
   「感染寄生蟲」可能只有 8 題,硬要抽 10 題會**靜默少題**,使用者看到的是
   「說好 50 題卻只有 48 題」
4. ⚠️ **避開上一場剛考過的題**(記住最近一場的 id,優先從補集抽)。連考兩場
   有一半重複的體感是「這功能壞了」

## 兩種模式

| | 複習模式 | 全真模式 |
| --- | --- | --- |
| 題源 | 考古題 + ASH + PO | 考古題 + ASH(**PO 不進**) |
| 對答案 | 每題送出即揭曉 + 詳解 | 交卷後逐題檢討 |
| 計時 | 無 | 有,預設 40 分鐘可調,時間到自動交卷 |
| 提示 | 有:首字母 / 主題分類 / 字數 | 無 |
| 重答 | 可回頭改 | 交卷前可改,交卷後鎖定 |

**PO 不進全真**:切片圖混進來會讓考卷不像考卷。ASH 是抹片,進。

⚠️ **提示用過要記錄(`hint_used`),成績頁分開算。** 用了提示還答對算全對很
合理,但「我全對」這個數字會騙自己 —— 而這個功能的全部價值就是誠實地告訴你
哪裡不熟。

**開場 dialog**(沒有年份,所以設定全在這裡):題數(預設 50)、模式、作答
寫法(全稱/縮寫/任意)、主題篩選(可只練淋巴系)、題源(含不含補充圖)。

## 計分

- 全對 1 分、半對 0.5 分、俗名 0 分、錯 0 分
- 總分轉百分制
- 成績頁**按主題分類拆開**(「髓系 12/15、淋巴 6/11」),並可一鍵「只練淋巴」
- 拼字正確率單獨一行,列出拼錯的那幾題
- 俗名次數單獨一行
- 錯題自動進「抹片錯題本」,**按診斷聚合**(「dacrocyte 你錯過 3 次」)

## 路由與頁面

頂端導覽**新增一項「抹片」**(會動到導覽階梯,見「測試」)。

| 路徑 | 內容 |
| --- | --- |
| `/smear` | 分頁:練習 / 作答記錄 / 錯題本 / 搜尋 |
| `/smear/s/:id` | 作答頁 |
| `/smear/s/:id/result` | 檢討頁 |
| `/smear/dx/:id` | 診斷詳情:共筆詳解 + 同診斷所有圖(標來源)+ 可接受寫法清單 + 提報入口 |

**搜尋完全獨立**,不跟 MCQ 共用端點。索引
`canonical + 所有 terms + topic + 詳解文字`。

## 「這個寫法也該算對」

沿用 `answer_challenges` 的形狀(提報 → 投票 → 自動 resolve),但**語意相反**:
MCQ 挑戰是「正解該換掉」(取代),這裡是「這個寫法也該收」(新增)。三個因此
不一樣的地方:

- **唯一鍵是 `(dx_id, normalized_text)`**,不是「一個 dx 一次只能有一個
  active」。同一個診斷可以同時有三個詞在投票,它們互不衝突。
- ⚠️ **被否決的詞要留墓碑(`status='rejected'`),不能刪列。** 刪掉的話同一個
  詞會被反覆提報,每次都要重投一輪 —— 同「其他筆記」那節標籤刪除留墓碑的
  理由。
- ⚠️ **通過後不追溯改分。** 追溯會讓成績頁的歷史數字自己變,而使用者記得
  上次考幾分。改成在那題的檢討頁標一行「你當時寫的 `dacryocyte` 後來被
  接受了」。

提報時要選 tier(全分 / 半分 / 俗名),因為「`echinocyte` 也該算對」跟
「`burr cell` 只能算俗名」是兩種不同的主張。

## 詳解:寫「怎麼判讀」,不是寫「答案是什麼」

⚠️ **詳解的價值不在告訴你答案,答案上一秒才剛揭曉過。** 它要回答的是
**「下次看到一張沒看過的片,我怎麼走到這個答案」** —— 所以是固定骨架的判讀
流程,不是一段自由散文。自由散文的問題是每個人寫的角度都不一樣,一百份詳解
看下來學不到共通的流程。

骨架(subagent 產初稿,共筆可改;掛在 `smear_dx`):

| 段 | 內容 |
| --- | --- |
| **一句話** | 這是什麼(定義,不含判讀) |
| **怎麼認** | 判讀流程:低倍先看什麼 → 高倍看什麼 → 決定性的那個特徵。細胞題固定走 **大小 / 核質比 / 核形與染色質 / 核仁 / 胞質顆粒與嗜鹼性**;紅血球形態題走 **形狀 / 大小 / 中央淡染區 / 內含物 / 分佈**;疾病題走 **哪一群細胞異常 → 異常在哪一個成熟階段 → 有沒有伴隨的背景變化** |
| **容易混淆的** | 跟哪一個像、**差在哪一點**。這一段最重要 —— 考卷上錯的多半不是「完全不會」,是「認成隔壁那個」 |
| **臨床脈絡** | 什麼情境會看到、看到之後下一步做什麼 |
| **拼字提醒** | 常見錯拼、以及**俗名 vs 正式術語**(`tear drop` → `dacrocyte`) |

**「容易混淆的」那一段要能連過去。** 寫到 `promyelocyte` 的鑑別提到
`myeloblast` 時,那是一個連到 `/smear/dx/<myeloblast>` 的連結 —— 抹片的
學習路徑本來就是在相似的東西之間反覆比較,而不是逐個獨立記憶。

**圖上的箭頭與 A/B 標註不寫在這裡**,寫在 `smear_questions.image_note` ——
那是這一張圖的事,不是這個診斷的事。

## 建置 pipeline

`scripts/build-smear-bank.py`:

1. 釘死 deck ↔ answer key 對應(錨點題驗證,見上)
2. PyMuPDF 每頁 render → **trim 純白四邊** → WebP。存兩份:`full`(長邊
   2400px,放大用)、`view`(長邊 1600px,預設)
3. 題幹文字從文字層抓(`What disease?` / `What cell?`),同時決定 `qtype`
4. 答案卷解析 → canonical + 括號替代 + 「半對」標記
5. **術語正規化(subagent)** —— 203 題產出
   `canonical_long / canonical_abbrev / full[] / half[] / lay[] / topic`。
   這一步一定會有爭議(`burr cell` vs `echinocyte` 該不該給分),**不追求一次
   到位** —— 進 DB 後靠上面的提報流程收斂
6. ASH 補充:每個 distinct canonical 挑最多 3 張同診斷的圖
7. PO 補充:slug → topic page → *Microscopic (histologic) images*,gentle scraper
8. 詳解初稿(subagent,照「詳解」那節的固定骨架產出),人再改

圖一律走現有 `/img/<key>` Worker proxy,**R2 不開公開** —— 這條不能因為
「只是補充圖」就鬆掉。每張補充圖存 `source` / `source_url` / `attribution`,
畫面上標出來。

## 測試

| 層 | 守什麼 |
| --- | --- |
| 純函式 | `gradeSmear()`:變音符正規化、Levenshtein 邊界、**tier 順序**(`lay` 必須排在 `full` 之後)、`pickSmearSet()`:largest remainder 加總必須等於 N、某類不足時缺額有沒有真的回填 |
| e2e | 走完一次練習(打字 → 送出 → 揭曉 → 提示標記)、全真交卷、成績頁按主題拆開。⚠️ **先斷言輸入格真的長出來**再斷言判定 —— 否則格子沒渲染時負面斷言恆真 |
| 既有防線 | `/smear` 加進 `eink.test.mjs` 的路由表;`overflow.test.mjs` 繞斷點重測(**導覽多一項會動到階梯**);`sw-guards.ts` 的 `CACHEABLE_API` **不准收 `/api/smear/*`** |

⚠️ **e-ink 下對錯不能只靠紅綠。** 全對 / 半對 / 俗名 / 錯是四種狀態,在 1-bit
下 emerald 跟 rose 會塌成同一種。用 `✓` / `◐` / `~` / `✗` 這四個字元加框線
語彙承載語意,顏色只是加強 —— 同 CLAUDE.md 「顏色沒了之後,語意要換一個維度
重講」那條。

## 成本

- R2:約 500 張 × 2 尺寸 ≈ 250 MB(free 10 GB)
- D1:表都很小
- **runtime 零 AI 呼叫** —— 詳解初稿由 subagent 離線產一次,不在請求路徑上
  燒神經元

全部在 free tier 內。

## Non-goals

- **不做 FSRS 排程。** 抹片練習是「掃過去找不熟的」,不是間隔複習;加排程會讓
  一個獨立功能長出對 `review_progress` 與排程邏輯的依賴。
- **不追溯改分。**
- **不混進現有統計。** 首頁熱力圖、弱點地圖、成績頁都不算抹片。
- **不強制字數。** 格子數是提示。

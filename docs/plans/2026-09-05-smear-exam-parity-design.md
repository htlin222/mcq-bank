# 抹片練習 × 筆試 操作一致性設計

2026-09-05

## 背景

抹片練習（`docs/plans/2026-09-03-smear-practice-design.md`）跟筆試 MCQ 系統在資料層
刻意完全分開——這個決定沒有錯,理由（測的是不同能力）站得住腳。但同一天內首頁改版
（#231）把抹片換成主力落地頁之後,兩套系統在**操作層**的落差開始被使用者感受到:
用慣筆試的人進到抹片,會覺得「同樣的動作,這裡卻不一樣」。

目標不是把抹片改造成筆試,而是讓**能共用的互動模式盡量共用**,只有在任務本質不同
的地方（選擇 vs. 拼寫）才允許分岔。

## 排序原則

改動成本 × 使用者撞到的頻率,兩者相乘決定優先度:

1. **入口/導覽結構**——成本最低,是第一個接觸點
2. **答後內容面板**——已有共用邏輯的雛形,收斂成本中等
3. **作答互動層**——成本最高,但重複次數最多、感受最深

## Layer 1:入口對稱 ——`/smear/exam`

### 現況問題

底部導覽四顆入口,筆試全部是真路由（`/review` `/exam` `/search` `/bookmarks`）;
抹片的「複習」是真路由（`/smear/review`）,但「全真」只是一顆按鈕直接彈
`StartDialog`,沒有對應網址。同一個位置、同一個圖示,行為卻不同——這是使用者從
筆試切到抹片的第一個接觸點,也是最容易讓人覺得「這裡怪怪的」的地方。

### 方案取捨

**重新檢查現有 `/smear/review`(#232)後發現它不是「表單搬進頁面」,是
「頁面觸發同一顆 `StartDialog` 彈窗」**——`SmearReview.tsx` 是一頁主題卡片,
點卡片才 `setDialogTopics(...)`,對話框本身完全沒動。這推翻了下面表格原本
設想的方案 A(把對話框整個搬成頁面表單);真正跟現有慣例一致的做法是方案 A'。

| 方案 | 做法 | 結論 |
| --- | --- | --- |
| **A'(採用,取代原案 A)** | 新增 `/smear/exam` 路由,做成跟 `SmearReview.tsx` 同款的極簡落地頁(返回連結/標題/一段說明 +「開始全真模式」按鈕),按鈕點下去開**同一顆** `StartDialog({initialMode:"exam"})`——對話框本身不動一行 | 跟 `/smear/review` 是同一套心智模型(路由 landing → 點按鈕/卡片開既有對話框),改動只是新增一個小元件,`StartDialog` 零風險 |
| A(原案,棄用) | 把 `StartDialog` 的表單內容整個搬成頁面(仿 `Exam.tsx` 的 `ExamStart`) | 跟 `/smear/review` 已經確立的慣例不一致——複習也沒有把表單搬進頁面,搬了反而讓抹片內部長出兩種不對稱 |
| B | 反過來把筆試 `/exam` 也改成對話框觸發 | 成本與風險都高:`/exam` 是重度測試過的既有路由(計時列/交卷確認/e2e),方向是退步 |
| C | 兩邊路由不動,抹片按鈕點下去先彈一個轉場確認框 | 治標不治本,斷層感沒有真正消除 |

### 設計細節

- 新檔 `frontend/src/routes/SmearExam.tsx`:結構抄 `SmearReview.tsx`(同一個
  `max-w-2xl` 容器、同一顆「回抹片練習」`<Link>`、`font-serif` 標題),內容只有
  一段說明(全真模式的特性:計時、交卷後才知道結果、PO 不進全真)+ 一顆
  「開始全真模式」主按鈕,`onClick` 設 `dialogOpen=true`,底部
  `{dialogOpen && <StartDialog initialMode="exam" onClose={...} />}`——跟
  `SmearReview.tsx` 的 `dialogTopics` state 是同一個形狀,只是不需要
  `initialTopics`(全真不篩主題)。
- `App.tsx` 的 `BottomAction`(全真那顆特例元件)拿掉,改成
  `<BottomItem to="/smear/exam" Icon={PenLine} label="全真" />`,四顆入口統一
  用 `NavLink`,`smearExamDialogOpen` state 與其 `<StartDialog>` 在 `App.tsx`
  的殘留一併移除(邏輯搬進 `SmearExam.tsx` 自己管)。
- 路由註冊表加一條 `<Route path="/smear/exam" element={<SmearExam />} />`,
  排在 `/smear/dx/:id`、`/smear/s/:id` 之前(同 `/smear/review` 的既有註解:
  路徑第二段是固定字面值,不會跟萬用參數衝突,但仍照慣例把具體路徑排前面)。
- `/smear/review` 完全不受影響,不用改。
- 既有 e2e(`smear-practice.test.mjs`)裡任何斷言「全真是一顆按鈕直接彈窗」
  的路徑要改成「先導到 `/smear/exam`,再點按鈕開對話框」。

## Layer 2:答後內容面板收斂(方向已定,細節待下一輪設計)

`Question.tsx` 的「題目/詳解/個人筆記/討論串/相似題目/影片」分頁邏輯,跟
`SmearDxPanel`(`/smear/dx/:id`,以及複習模式作答後嵌入的那塊)概念上是同一件事,
但兩邊是完全獨立的元件,各自重寫了分頁行為與手機/桌機版型判斷。

方向:抽出一個雙方共用的「內容分頁殼」元件(分頁列本身、窄螢幕摺疊/溢出邏輯、
`KeepAlive` 的凍結子樹策略),`Question.tsx` 跟 `SmearDxPanel` 各自只提供分頁清單
與各分頁的內容渲染器。

**這一層不在本次實作範圍**——細節(共用元件的 props 介面、兩邊分頁清單長度不同
要怎麼處理階梯斷點)留到下一輪設計,先做 Layer 1 跟 Layer 3。

## Layer 3:選擇題提示(複習模式,提示鏈第四層)

### 定位

現有 `AnswerInput.tsx` 的提示鏈實際只有「主題分類」跟「直接看答案」(複習模式限定)
兩層——設計文件原規劃的「首字母」「字數」都沒做,「字數」甚至是刻意拿掉的(103 個
診斷的題庫裡,格數會洩漏答案字數)。中間空了一大段:主題分類太籠統,直接看答案又
太重。

「看選項」補的正是這一段,同時也是 Layer 3(作答互動層落差)最小可行解:一旦
打字題也有一條「切換成選擇題作答」的正式退路,就不需要另外幫自由輸入框做手把
方案——沿用筆試 `QuestionCard` 現成的選項/送出/手把互動元件即可。

只在複習模式出現,跟現有兩個提示並列(不是新模式;全真模式維持「無提示」)。

### 干擾選項生成

新的伺服器端點:

```
POST /api/smear/sessions/:id/mc-options
body: { questionId: string }
→ { options: string[] }   // 5 個洗牌過的 canonical_long,不含正解索引
```

複用 `resolveQuestionIdx`(跟 `/answer` 端點同一套,處理 opaque `#idx` token)解出
真實 `questionId` 與其 `dx_id` / `topic`。

純函式 `pickMcqDistractors()`(`worker/lib/smear-mcq.ts`,rng 由呼叫端注入,同
`pickSmearSet()` 的慣例):

1. 同 `topic` 底下隨機抽 4 個不同 `dx_id`(排除正解)
2. ⚠️ **不足 4 個時,缺額從其他 topic 回填**(同 `pickSmearSet()` 缺額補足的邏輯)
   ——「感染寄生蟲」這類小 topic 不能因為候選不夠就讓選項少於 5 個
3. 正解 + 4 個干擾項洗牌回傳

「同 topic 抽」是複用 `pickSmearSet()` 已經在用的分類軸,不新建一套相似度演算法
——白血球相關診斷天然只會混到白血球相關診斷。

### 安全模型

正解與干擾項的組合**必須在伺服器產生**,不能在前端組——抹片這條線已有「id 內嵌
答案/dx_id 揭曉閘/finish 前的 `/wrong` 外洩」三層既有防線,前端若自己從已知診斷
清單組排列組合,network tab 就看得到哪個是正解。回應只給洗牌後的文字陣列,不給
索引或任何能推出正解位置的欄位。

### 互動

按下「看選項」後,`AnswerInput` 的自由輸入框**整個換成**單選清單(不是並存)——
沿用 `QuestionCard` 既有的選項/送出/手把互動,選中一個、按送出(或面鍵確認),
送出的字串就是選到的 `canonical_long`,走現有 `submitSmearAnswer`,
`hintUsed: 'mc_choice'`。

### 計分與誠實帳

- 選到正解一樣算全對(跟「用主題分類提示也能全對」原則一致,`hint_used` 記錄
  但不影響分數)。
- ⚠️ **原本設想「不能算進拼字正確率」,查過現有程式碼後發現這個數字目前根本
  不存在於複習模式。** 「拼字完全正確:N 題」(`SmearResult.tsx:225`,
  `spelling_ok`)只在 `POST /sessions/:id/finish` 算,而 `finish` 只有全真模式
  會呼叫(複習模式沒有交卷、沒有 session 完成的概念——`SmearDashboard`/
  `SmearReview` 的「正確率」統計也都是 `score/max_score`,同樣只吃已 finish 的
  場次)。MC-hint 限定複習模式,兩者的交集是空的:**沒有任何現有聚合會讀到
  `hint_used='mc_choice'` 的列**,不需要另外加排除邏輯——加了也是永遠不會被
  執行的防禦性程式碼。
- **原則留著,只是暫時沒有對應的實作要改**:如果複習模式未來也長出「拼字正確率」
  這種聚合統計,那支查詢要記得排除 `hint_used = 'mc_choice'` 的列,理由不變
  (那個數字答的是「你寫不寫得出來」,用選的沒有打字這回事)。這行加在這裡
  是留給下一個真的要做那個功能的人看的。
- 「用了幾次提示」目前也沒有聚合統計(只有 `smear_answers.hint_used` 這個
  逐列旗標),所以 MC-hint 不需要新增或修改任何既有統計行——`hint_used` 多一種
  取值(`'mc_choice'`)即可,跟 `'topic'`/`'reveal_answer'` 並列。

## 測試

| 層 | 守什麼 |
| --- | --- |
| 純函式 | `pickMcqDistractors()`:同 topic 優先、缺額回填其他 topic、正解一定在洗牌後的 5 個裡、不重複 |
| e2e | 進入 `/smear/exam` 直接看到設定表單(不是跳出彈窗);「看選項」按下後輸入框消失、選項清單出現;選中後送出算全對;手把在選項模式下可以選取/確認(沿用既有 `QuestionCard` 手把測試的斷言方式) |
| 既有防線 | `/smear/exam` 加進 `eink.test.mjs`、`overflow.test.mjs` 的路由表(底部導覽入口性質改變,可能動到導覽階梯量測) |

## Non-goals

- **不做「MC-hint 選對打折扣分」。** 跟現有提示鏈(主題分類)同一套誠實帳邏輯:
  用了提示依然可以全對,只在統計頁另外揭露用了幾次提示,不在分數上懲罰。
- **Layer 2(答後內容面板收斂)不在本次範圍**,方向已記錄,細節留待下一輪設計。
- **全真模式不會有選擇題提示**,維持「全真無提示」的既有原則。
- **不新建相似度演算法。** 干擾項生成沿用既有 `topic` 分類軸,不因為這個功能
  另外分析「哪些診斷容易混淆」。

# 換題延遲:診斷與修法

2026-08-07

「按下一題之後,資料要等個幾百毫秒才進來」的處理。結論先講:**慢只是其中一半,
另一半是那段時間畫面上放著錯的東西。**

## 症狀拆解

四個獨立成因,合起來造出那個「按了沒反應,然後整頁跳掉」的感覺。

### 一、`data` 不隨 id 清空 —— 使用者看到的是上一題

`/q/:id` 沒有 `key`,所以換題時 `Question` 元件不重掛(`Question.tsx` 裡那句
「Same component instance, so useState alone wouldn't reset」就是在講這件事)。
舊版 `useQuestion` 只在抓成功時 `setData`,於是新題目回來之前,畫面上完整保留
**上一題**的題幹、選項、以及已經揭曉的答案。

這比空白更糟:

- 前兩三百毫秒看起來像「點擊沒生效」,使用者會再按一次。
- 已揭曉的答案還在,等於替下一題預先劇透了氣氛(雖然內容是上一題的)。
- 在交錯練習(`Drill.tsx`)裡更嚴重 —— 那裡的卡片可以直接作答,理論上存在
  「以為在答第 3 題、其實畫面還是第 2 題」的窗口。

### 二、Worker 端四趟序列 D1 往返

`GET /api/questions/:id` 原本是三個各自 `await` 的查詢(questions、explanations、
question_tags),之後才進到一個六查詢的 `Promise.all`。那三個彼此不相依,卻排隊
跑,每趟 D1 都是實打實的 round-trip。

### 三、上一題/下一題的清單每次都重抓

`/api/questions?year=X&limit=200` 在**題目載入完成之後**才發,所以導覽按鈕永遠慢
題目半拍。而一年的題目清單,只有發布新年份時才會變。

### 四、完全沒有預抓

`navNext` / `navPrev` 早在按鈕渲染時就已知,卻沒有人拿它去暖身。

## 修法

四層,由內而外。

### 1. Worker:四趟併成一趟

九個查詢全部進同一個 `Promise.all`,404 檢查移到之後。代價是題目不存在時另外八個
空集合查詢也送出去了 —— 拿罕例的一點浪費,換常見路徑少兩趟 RTT。

### 2. `questionStore`:一個可測的 LRU + in-flight 去重

`frontend/src/lib/questionStore.ts`。存在的理由只有一個:讓 `peek()` 在 **render
當下同步**回答「這題的資料在不在手上」。有的話 `useQuestion` 第一次 render 就畫得
出完整題目,連 loading 狀態都不進。

- LRU 40 筆、TTL 60 秒。過期**不丟**,仍然先畫舊的再背景重抓(SWR)。
- 同一 id 併發只打一次網路;失敗不留痕,下次會重試。
- 純函式風格,fetcher 由呼叫端注入 → 13 條單元測試不需要瀏覽器。

**為什麼不改 Service Worker 就好。** `/api/questions/:id` 在 `sw.ts` 是
NetworkFirst,拿快取前一定先等網路。改成 StaleWhileRevalidate 確實會快,但會讓
「存完詳解 → reload 看到自己的修改」讀到舊值 —— 那是比慢更糟的錯。快取因此做在應
用層,失效時機我們自己掌握。SW 的 Access-redirect 防護一行未動。

**為什麼不引入 TanStack Query。** 整個 app 只有這一條熱路徑需要它。一個一百行、
自己有測試的 store,比多一個 runtime 依賴划算。

### 3. `useQuestion`:資料跟著 id 走

資料連同「它屬於哪一題」一起存,只在 `entry.id === id` 時才當作有資料。於是:

- 預抓命中 → 第一次 render 就有完整資料。
- 沒命中 → 顯示骨架,而不是上一題。
- **同一個 id 的重抓不受影響** —— 存完詳解後的 `reload()` 因為 id 沒變,畫面不會
  空白。原本那句「keep rendering even during a refetch」的意圖被完整保留,只是把
  「refetch」跟「換題」這兩件本來混在一起的事分開了。

快速連按時,先發後到的請求由一個 ref 擋掉,不會把畫面倒退回去。

### 4. 預抓與轉場

- **閒置預抓**:`requestIdleCallback`(Safari 沒有,退回 400ms `setTimeout`)抓
  上下題。排在 idle 是為了不跟本題自己的請求(詳解、留言、相似題)搶頻寬;離線時
  不抓。
- **指標暖身**:`onPointerEnter` / `onPointerDown` / `onFocus` 再補一次,等於在點
  擊前偷到約 100ms。idle 已命中時 `prefetch()` 自己 no-op。
- **年度清單快取**:五分鐘 TTL,同年度換題不再重抓 → 導覽按鈕跟題目同一幀出現。
- **骨架延後 120ms**:撐不過 120ms 的等待使用者感覺不到,骨架閃一下再被真內容取代
  比直接等更吵。
- **捲動歸零**:元件不重掛,捲動位置本來不會自己回頂端。停在下一題的半空中,是先
  前最容易被誤認成「載入失敗」的症狀之一。
- **140ms 淡入**:預抓命中時內容瞬間換掉,快到眼睛會懷疑有沒有換。用 WAAPI
  (`element.animate`)而**不是** `key`/remount —— 重掛整棵子樹會連 TipTap 一起重
  建,那正是 2026-07 iOS 白屏的成因。尊重 `prefers-reduced-motion`。

交錯練習(`Drill.tsx`)的整組 id 一開始就全知道,同樣預抓左右鄰居。

## 驗證

`frontend/e2e/nav-prefetch.test.mjs`(WebKit)。做法是把 fixture 伺服器的每個
`/api/` 回應延遲 700ms,於是「有沒有預抓到」變成可觀測的時間差:命中就不必付這段
延遲,沒命中就得付滿。門檻設在 300ms,遠低於延遲本身,量的是機制不是機器快慢。

三條斷言:換題耗時 < 300ms、換題後畫面不殘留上一題、同年度換題不重抓年度清單。

實測把閒置預抓拿掉之後第一條會紅 —— 這條測試是真的守衛,不是套套邏輯。

## 沒有做的事

- **年度列表 hover 預抓。** 進題庫的第一次點擊仍要等一趟。加上去很容易,但會讓
  滑鼠掃過清單就產生一串 Worker 呼叫;等真的覺得第一次點擊慢再說。
- **View Transitions API。** react-router 6.26 還沒有 `viewTransition`,為了一個
  淡入升級路由庫不划算。WAAPI 已經足夠。
- **SW 改 SWR。** 理由見上。

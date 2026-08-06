# 手把操作 (Gamepad) 設計

2026-08-06 · 目標裝置:8BitDo Pro 2(X 模式)

## 為什麼不是 gamecontroller.js

原始需求指向 [alvaromontoro/gamecontroller.js](https://github.com/alvaromontoro/gamecontroller.js)。
評估後改為自包一層,理由是它買不到我們需要的東西:

- npm 最後發版 `1.5.0` @ 2020-07,`main` 指向 UMD bundle,無 ESM entry、無型別。
- import 即啟動全域 `requestAnimationFrame` 迴圈,沒有乾淨的停止路徑 —— 對一個
  99% 時間沒接手把的讀書網站是白燒電。
- 它的 `up`/`down`/`left`/`right` 事件是**類比搖桿**軸向,十字鍵只以
  `button12`–`button15` 這種原始名稱丟出來。語意層我們照樣得自己寫。
- **完全沒有震動 API**。`vibrationActuator` 是這次的明確需求之一,它讀不寫。

原生 Gamepad API 的輪詢器約 120 行,換來可控的節流、去彈跳、暫停與震動。

## 架構

```
frontend/src/lib/gamepad.ts          純邏輯 + 單例輪詢器 + rumble
frontend/src/hooks/useGamepad.ts     useGamepad / useGamepadScroll / useGamepadConnected
frontend/src/components/GamepadFab.tsx  左下說明 FAB
```

### 單例輪詢器,而非每個 hook 一個迴圈

複習模式同時有兩個訂閱者(`QuestionCard` 管選項與作答,`Question` 管上下題與
分頁),各自起一個 rAF 迴圈會讓同一次按壓被讀兩次、邊緣偵測互相打架。
`lib/gamepad.ts` 持有唯一的 poller 與一組 subscriber;`useGamepad()` 只是註冊。

輪詢**只在「有訂閱者」且「有手把連著」時執行**。透過 `gamepadconnected` /
`gamepaddisconnected` 起停。Chrome 本來就要先按一下按鈕才會在
`navigator.getGamepads()` 揭露手把,而 `gamepadconnected` 正好在那一刻觸發,
所以這個條件不會漏掉初次連線。

### 邊緣觸發與長按重複

每幀比對上一幀的按下狀態,只在 `false → true` 發出動作。十字鍵額外給
自動重複(400 ms 延遲、之後每 120 ms),因為年度列表有 100 筆、模擬考有
100 題,沒有長按就不能用。面鍵與肩鍵**不重複** —— 收藏、送出、交卷重複觸發
是傷害。

### 搖桿捲動與捲動目標

左搖桿 Y 軸走另一條訂閱通道(`useGamepadScroll`),每幀連續回報而非邊緣觸發,
死區 0.25,速度隨推桿量平方遞增。

複習模式的 columns 版型**每一欄是自己的捲動容器**,頁面本身不捲。所以捲動目標
不能寫死成 `window`:頁面透過 `getScrollEl()` 回傳當前該捲的元素(columns 模式
回右欄,tabs 與手機版回 `null` 代表捲 window)。

### 8BitDo Pro 2 的模式開關

只有 **X 模式**會讓瀏覽器回報 `gamepad.mapping === 'standard'`,索引才對得上
下表。S(Switch)模式常回報空字串 mapping 且面鍵位置對調。偵測到非 standard 時
在 FAB 面板顯示提示,而不是靜默錯位。

標準映射索引:

| index | 位置 | index | 位置 |
|---|---|---|---|
| 0 | FACE ▼ | 8 | SELECT |
| 1 | FACE ▶ | 9 | START |
| 2 | FACE ◀ | 12 | DPAD ↑ |
| 3 | FACE ▲ | 13 | DPAD ↓ |
| 4 / 5 | L1 / R1 | 14 | DPAD ← |
| 6 / 7 | L2 / R2 | 15 | DPAD → |

## 震動

`gamepad.vibrationActuator.playEffect('dual-rumble', …)`,包成 `rumble(preset)`:

| preset | 觸發時機 | 波形 |
|---|---|---|
| `tap` | 按下送出的當下 | 60 ms,weak 0.4 |
| `correct` | 伺服器回 `correct: true` | 兩下 40 ms 輕快 |
| `wrong` | 答錯 | 一次 180 ms,strong 0.6 |

**為什麼送出要震兩段。** 送出到 API 回來之間有網路延遲。只在按下震,對錯就沒有
回饋;只在回應震,手感會慢半拍、按起來像沒反應。所以按下先 `tap`,回應到了再
依對錯補一次。

開關存 `localStorage['gamepad-rumble']`,比照既有的 `review-layout-mode`。

**Safari / WebKit 沒有 `vibrationActuator`**,`rumble()` 靜默 no-op。iPad 接手把
可以完整操作,只是不會震。這不擋任何功能。

## 按鍵映射

### 複習模式 `/q/:id`

| 手把 | 未作答 | 已揭曉 |
|---|---|---|
| DPAD ↑ / ↓ | 選項游標(移動即選取) | 捲動當前面板 |
| DPAD ← / → | 信心度 猜 / 普通 / 有把握 | — |
| FACE ▼ | 送出答案(+ 震動) | — |
| FACE ◀ | 略過 / 直接看答案 | — |
| FACE ▲ | 複製題目 Markdown | 同 |
| FACE ▶ | 收藏 | 同 |
| L1 / R1 | 上一題 / 下一題 | 同 |
| L2 / R2 | 上一個 / 下一個分頁 | 同 |
| START | 回年度列表 | 同 |
| 左搖桿 | 捲動 | 捲動 |

「移動即選取」讓十字鍵等同鍵盤的 A–E:游標到哪就選哪,FACE ▼ 單純是送出。
不做「高亮 → 確認 → 送出」兩段式,那會讓手把與鍵盤的行為分歧。

信心度那一列只在 `!revealed && chosen` 時存在(`QuestionCard.tsx`),所以
DPAD ← / → 只有在「已選、未送出」的窗口內有事做,其餘時候是 no-op。

### 全真作答 `/exam/:sid`

| 手把 | 動作 |
|---|---|
| DPAD ↑ / ↓ | 選項游標(即選取,沿用 `choose()`) |
| DPAD ← / → | 上一個 / 下一個**標記**題 |
| FACE ▼ | 確認並前進下一題(+ `tap` 震動) |
| FACE ◀ | 暫停 / 繼續 |
| FACE ▶ | 標記 / 取消標記本題 |
| FACE ▲ | 跳到第一題未作答 |
| L1 / R1 | 上一題 / 下一題 |
| L2 / R2 | −10 題 / +10 題 |
| START | 交卷 —— 走既有 `submit()`,含未答題數確認對話框 |

L1/R1 刻意與複習模式同義(上一題 / 下一題)—— 兩個模式之間切換的人不該重學
肩鍵。剩下的鍵才拿去補這一頁獨有的動作:模擬考沒有信心度,十字左右改成在標記題
之間跳(回頭檢查的動線);沒有「直接看答案」,FACE ◀ 改成暫停 / 繼續,那本來
是只能用滑鼠點的控制。

初稿曾把 FACE ◀ 訂為「留白跳過並前進」—— 但選項是移動即選取,那跟 FACE ▼
只差在有沒有震動,等於兩顆鍵做同一件事。

START **不一鍵交卷**。`submit()` 本來就會在有未答題時 `confirm()`,手把沿用同一
條路徑,不另開快速通道。

### 年度列表 `/year/:y`

| 手把 | 動作 |
|---|---|
| DPAD ↑ / ↓ | 題目游標(長按連續移動,自動 `scrollIntoView`) |
| DPAD ← / → | 切換作答狀態篩選 |
| FACE ▼ | 進入該題 |
| L1 / R1 | −10 筆 / +10 筆 |
| L2 / R2 | 切換組別篩選 |
| START | 回 `/review` |

篩選變動時游標歸零 —— 停在一個已被篩掉的索引上,視覺會沒有游標。

## GamepadFab

左下角 `<Gamepad2 />` FAB,**只在偵測到手把時出現**(`useGamepadConnected`)。
點開是當前頁的按鍵表 + 震動開關 + 非標準 mapping 警告 + 手把型號。

只在有手把時出現,同時解決了發現性與干擾:沒接手把的人不會看到一顆意義不明的
按鈕,接了手把的人第一眼就知道能按什麼。

### 「什麼時候算連上」

**瀏覽器不會在藍牙配對完成的當下揭露手把。** 為了防指紋追蹤,`getGamepads()`
一直回傳空的,直到使用者在手把上按下第一顆按鈕 —— `gamepadconnected` 也是那時
才觸發。所以「配對好了但網頁還看不到」是個沒有 API 能偵測、也沒辦法提示的狀態。

能做的是把「看得到了」這件事講清楚:連上的那一刻,FAB 上方跳出一則五秒的膠囊
提示(`8BitDo Pro 2 已連線 · 看操作說明`,點了直接開面板)。它出現的時機正好是
第一次按鍵被收到的瞬間,所以同時證明了三件事 —— 網頁看到手把了、按鍵有通、
說明在哪裡。

不需要任何啟用開關。接上、按一下,就能用。

位置與既有 FAB 共存:`BackToTopFab` 也在左下(`md:hidden`),所以 < md 時把
手把 FAB 往上讓 3.5 rem;`PomodoroFab` 在右下,不衝突。

## 測試

- 純函式(索引 → 動作、邊緣偵測、長按重複時序、死區曲線)進 `pnpm test`。
- **端對端按下去** 走 `frontend/e2e/gamepad.test.mjs`。Playwright 沒有手把 API,
  但輪詢器唯一的輸入來源是 `navigator.getGamepads()`,用 `addInitScript` 換掉它
  就夠了 —— rAF 輪詢、邊緣偵測、語意動作、React state、DOM 全都是真的在跑,
  只有最外層那顆塑膠是假的。`vibrationActuator.playEffect` 一併攔下來記錄,
  所以「送出時會震兩段、關掉之後一段都不震」是被斷言的。

### 兩個只有這種測試抓得到的 bug

**一次按壓穿過兩層頁面。** 換頁時 React 先卸載舊路由的訂閱、再掛上新路由的,
中間 `actionSubs` 會空一瞬間,輪詢器因此停下來。而一次真實按壓長達 100ms 以上,
橫跨得過那個縫 —— 重啟時那顆「還按著」的鍵被讀成新的邊緣,於是新頁面吃到同一下。
實測:題目頁按 START,直接穿過年度列表落到 `/review`。修法是 `primeStates()`:
啟動輪詢時先把當下已按著的鍵記成「已按下」,不當成新按壓。單元測試碰不到這個,
因為它的成因是「按壓有持續時間」。

**沒有 options 的 payload 會白屏。** `question.options[L]` 在 render 途中丟
TypeError,React 18 的反應是卸載整棵樹。SW 會 runtime cache
`/api/questions/:id`,所以舊 schema 的快取回應是真的搆得到這條路。已改成 `?.`。

- 三頁的渲染安全網仍走 `smoke.test.mjs`,重點是 WebKit **沒有**
  `vibrationActuator`,`rumble()` 在那裡不能拋。
- 假手把驗得到映射與時序,驗不到實體按鍵位置。8BitDo Pro 2 的模式開關
  (X / S / D / M)只能實機確認。

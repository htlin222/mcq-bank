# Head First 架構觀

用《Head First Software Architecture》（Raju Gandhi、Mark Richards、Neal Ford，O'Reilly 2024）這本入門書的骨架，回頭解釋 **mcq-bank（hema-2026）為什麼長這樣**。

## 引言

《Head First Software Architecture》是一本給「還不是架構師的工程師」的入門書：它不教你背風格清單，而是給你一套**看待任何系統的座標系**。這頁把那套座標系套在本專案上——就算你沒讀過書，也能看懂本 repo 每個看似奇怪的決定背後的邏輯。

書的骨架很小，只有 **四個維度** 加 **兩條定律**:

- 四維度:**架構特性**（要多好）、**邏輯元件**（切成幾塊）、**架構風格**（怎麼拓樸）、**架構決策**（憑什麼這樣切）。
- 兩定律:**一切皆取捨**、**why 比 how 重要**。

底下每一節先用 2–4 句白話講清楚概念,再立刻落到本專案的一個真實檔案或決定上。

## 架構 vs 設計

書裡最實用的一把尺:**「改這個決定有多痛?」** 改起來要動全站、幾乎等於重寫的,是**架構**;局部可逆、改壞了半天內能回滾的,是**設計**。架構師要盡量把難逆轉的決定推遲、把可逆的決定下放。

| 層級 | 本專案例子 | 為什麼歸這層 |
|---|---|---|
| **架構級**（改了很痛） | 認證交給 Cloudflare Access(Zero Trust)、app 層零 auth code(見 [簡介](Introduction)) | 改成自架密碼/session 等於重寫整個信任邊界、動到每條 route 的身分假設 |
| **架構級**（改了很痛） | 資料庫選 D1(SQLite);詳解、討論、challenge 都設計成單庫關聯 | 換 Postgres/外部 DB 會失去邊緣同址與免費額度,連帶動搖成本假設 |
| **設計級**（改了不痛） | `explanations` 表的鎖每 60 秒續一次(`editing_until`) | 續期間隔是一行常數,調成 30 或 90 秒是局部、可逆、無人會注意到的改動 |
| **設計級**（改了不痛） | roster email 讀 CSV 的 column index(`sync-access.ts`) | 改讀 header row 是單檔局部改動,不影響任何其他元件的契約 |

判斷訣竅:如果你得同時通知前端、後端、資料庫三邊才能安全改動,那多半是**架構**;如果改動被關在一個檔案、一個常數裡,那是**設計**。架構師的功力,正在於把越多決定留在右邊那一格。

## 四個維度

### a) 架構特性(-ility):系統要「多好」

架構特性就是那些以 -ility 結尾的非功能需求——可維護性、可用性、可擴展性、安全性……。書的重點是:**你不可能全要**,必須挑出少數幾個「驅動特性」,其餘明確放掉。本專案的驅動特性被一條硬約束逼出來:**全站必須落在 Cloudflare 免費額度內**。

| 驅動特性 | 在本專案的具體形貌 |
|---|---|
| **成本效率**(cost) | 20 人重度使用預期 **$0/月**;任何會超額度的東西(如 Durable Objects 需 Paid $5/月)都必須明講,不可默默加 |
| **可維護性**(maintainability) | `./scripts/deploy.sh` / `sync-access.ts` 皆 **idempotent**;`config.toml` 單一事實來源;`pnpm db:pull` 把 prod D1 鏡像回本地 |
| **安全性**(security) | Cloudflare Access 白名單 + Email OTP、無密碼;R2 bucket 不公開,圖片走 `GET /img/:key` Worker proxy |

**刻意不追求的特性**:大規模**可擴展性**(目標就是 5–50 人,不為百萬用戶設計)、**即時協作性**(共編刻意用 pessimistic lock 而非 CRDT)、**公開可及性**(題目屬考選部,明確不對外開放)。放掉這些,才買得起上面那三個。書裡最反直覺的一句:**沒被列為驅動特性的,就要主動、明確地放棄**——含糊地「順便也想要一點」才是架構腐化的起點。本專案把「明確不做」寫進 [路線圖](Roadmap),就是這條紀律的落地。

### b) 邏輯元件:內聚與耦合

邏輯元件是系統在「概念上」切成的幾塊,好架構追求**高內聚**(一塊只管一件事)與**低耦合**(塊之間靠窄介面往來)。本專案雖小,邊界卻畫得很清楚:

| 元件 / 邊界 | 職責 | 邊界理由 |
|---|---|---|
| 前端(Pages, React+Vite) ↔ 後端(Worker, Hono) | UI 與 `/api·/img·/pdf` 分離,dev 靠 Vite proxy 注入 `X-Dev-Email` | 前後端可各自部署;本地開發不需真 Access |
| `config.toml`(單一事實來源) | 收攏所有 per-fork 識別字(slug、host、資源名、admin email) | 把「哪個 fork」這件事從程式碼裡抽出,換科別讀書會 15 分鐘開新站 |
| R2 proxy 邊界 | 上傳 `POST /api/upload` → UUID key;讀取 `GET /img/:key` | bucket 不公開,讓儲存層與 Zero Trust 邊界對齊,URL 外洩也拿不到內容 |
| answer challenge / 官方答案 | 社群對官方答案提異議、投票升級,與 importer 分權 | 內聚在自己的表與流程;importer 被明令「never clobber community-revised answers」以免踩過邊界 |

書提醒:元件邊界畫錯的代價,往往要到「一次小改動害你得同時動很多塊」時才浮現。本專案的 importer 曾無條件 upsert、把 challenge 升級的答案蓋回 CSV——那正是**耦合過緊**的教訓,修法(見 [技術債](Tech-Debt) 償還紀錄)本質就是重新劃清 importer 與 challenge 的邊界。

### c) 架構風格

書把風格分兩大陣營:**單體**(一個部署單元,內部分層,簡單但共進退)與**分散式**(多個獨立服務,彈性高但要付網路/一致性/運維的稅)。多數團隊高估自己需要分散式。

本專案是 **內部分層的無伺服器 client-server**:一個 Worker(Hono)就是**單一部署單元**,內部按 route/資料存取分層;前端是分離的 SPA;D1、R2、Access、Workers AI 是**代管服務**而非自己維運的微服務。它**不是** microservices——這正是被驅動特性逼出來的結果:多一個服務就多一份運維與可能的付費,直接違背「成本效率 + 可維護性」。單體 + 代管後端,讓一個人一鍵 `deploy.sh` 就能顧住全站。

換句話說,分散式風格能買到的彈性(獨立擴縮、團隊分工)本專案根本用不上,卻得先付網路一致性、部署協調、可觀測性的稅——對 20 人讀書會是純虧損。書的建議「**先預設單體,拿不出分散式的具體理由就別分**」,在這裡被貫徹到底。

### d) 架構決策(ADR)

架構決策記錄(ADR)用三段式寫下一個決定:**Context**(什麼處境)、**Decision**(決定怎麼做)、**Consequences**(換來什麼、賠上什麼)。關鍵是 Consequences 必須同時寫**好處與代價**,誠實面對取捨。本專案的 [簡介](Introduction) 關鍵設計決策一節,本質上就是一串 ADR:

| 決策 | ＋ 換到的 | － 賠上的 |
|---|---|---|
| **認證用 Zero Trust,app 內零 auth code** | 零 auth 程式碼、零 session/密碼漏洞面、免維護登入 | 綁死 Cloudflare Access、受 50 seats 上限、脫離 CF 生態要重做 |
| **詳解存 TipTap/ProseMirror JSON,不存 HTML** | 零 XSS(唯讀渲染不用 `dangerouslySetInnerHTML`)、可平移 Yjs、可結構化查 mention | 不能直接當 HTML 用,需 renderer;匯出/SEO 較費工 |
| **共編用 pessimistic lock,刻意不用 CRDT** | 零額外成本(不需 Durable Objects/付費)、實作簡單 | 有殭屍鎖(最長 5 分鐘)、非真即時,規模再大會痛 |
| **per-fork 設定收攏進 `config.toml` 單一事實來源** | 換科別讀書會 15 分鐘開新站、程式碼零硬編 slug/資源名 | `config.toml`/`wrangler.toml`/`.env` 三檔 gitignored,需靠 `.example` 模板維持一致 |

寫 ADR 的紀律很簡單:**Consequences 那一格若只寫得出好處,代表你還沒真的想清楚**。上表每一列都逼自己寫出「賠上的」,這正是本 repo 決策不會事後後悔的原因。

## 兩條定律

### 第一定律:一切皆取捨

書開宗明義:「There are no right or wrong answers in architecture — only trade-offs.」沒有免費的好處,每個決定都是**買到一些、付出一些**。本專案最大的那一筆:

| 這個決定 | 買到 | 付出 |
|---|---|---|
| 全站押在 Cloudflare 免費額度 | 零成本、免運維、邊緣低延遲 | 受額度上限與 D1 限制綁住,某些功能(即時共編)直接被擋在付費牆外 |
| 開放共筆詳解 | 20 人協作補題的複利價值 | 必須用 Access 白名單 + OTP 擋濫用,天生無法對外公開 |
| pessimistic lock 而非 CRDT | 省下一個服務、省下 $5/月 | 放棄真即時,接受殭屍鎖與「一次一人編輯」 |

### 第二定律:why 比 how 重要

書的第二定律:**架構文件真正該留下的是「為什麼」,不是「怎麼做」**——how 會隨技術過時,why 幾年後仍是判斷改動對錯的依據。本 repo 的 why 到處都留了痕跡:

- [簡介](Introduction) 每條決策都附一句 why(例:「**不要**在 app 層加註冊/改密碼——那是錯的層」)。
- [技術債](Tech-Debt) 開頭定原則:「**考前只還會咬人的債**」——這是取捨的 why,不是清單。
- [路線圖](Roadmap) 有「**明確不做**」一節(App 層帳號、公開題庫、為好看而改 UI),把「不做什麼」與理由一起寫死。
- Commit message 記債的償還理由(如 `fix(import): never clobber community-revised answers`)。

## 帶得走的一課

mcq-bank 之所以長這樣,不是因為 Cloudflare 最潮,而是因為**「免費額度」這條硬約束逼出了成本、可維護性、安全性三個驅動特性,再由它們一路推導出單體無伺服器風格與每一個取捨**——這就是書要教的:先問清楚要哪幾個 -ility,架構的形狀自然浮現。

## 延伸閱讀

| 頁面 | 內容 |
|---|---|
| [簡介 Introduction](Introduction) | 本頁引用的關鍵設計決策原文(等同一串 ADR) |
| [技術債 Tech-Debt](Tech-Debt) | 取捨的另一面:被推遲的償還與其 why |
| [路線圖 Roadmap](Roadmap) | 保留的升級路徑與「明確不做」 |

- 書:Raju Gandhi、Mark Richards、Neal Ford,《Head First Software Architecture》,O'Reilly, 2024。

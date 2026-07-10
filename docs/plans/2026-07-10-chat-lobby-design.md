# 聊天大廳(Chat Lobby)設計

日期:2026-07-10
狀態:已與 owner 確認,實作中

## 目標

一個全站共用的「聊天大廳」分頁:即時聊天、可調通知(toast)偏好、
@人、@all、@題號、emoji 反應、回覆引用,桌機與手機都要好用。

## 已確認的決策

| 決策 | 結論 |
|---|---|
| 訊息保存 | DO 自帶 SQLite,只留最近 500 則(自動修剪),不進 D1 |
| @all 權限 | 所有人可用 |
| 通知偏好 | 存 `users.chat_notify`(跨裝置),值:`all` / `mention` / `off`,預設 `mention` |
| 鈴鐺整合 | @我 / @all 且**當下不在線(未連 WS)**的人,寫入 `notifications`(kind=`chat_mention`),點了跳 `/chat` |
| 訊息格式 | 純文字(非 TipTap),聊天定位輕量 |

## 免費方案確認

SQLite-backed Durable Objects 在 Workers **免費方案可用**(CLAUDE.md 裡
「DO = Workers Paid」是舊資訊)。搭配 WebSocket Hibernation API,閒置連線
不計 duration,20 人使用量遠低於免費額度(10 萬 requests/日)。

## 後端

### `ChatRoom` DO(`worker/chat-room.ts`)

單一房間:`idFromName("lobby")`。SQLite-backed(`new_sqlite_classes`),
WebSocket Hibernation API(`ctx.acceptWebSocket` + `webSocketMessage`),
identity 用 `serializeAttachment` 存活過 hibernation。
`setWebSocketAutoResponse("ping"→"pong")` 保活不喚醒 DO。

DO 內 SQLite:

```sql
messages(id INTEGER PK AUTOINCREMENT, email, name, text,
         mentions TEXT '[]', mention_all INTEGER 0,
         reply_to INTEGER, reply_name TEXT, reply_snippet TEXT,
         created_at INTEGER)
reactions(message_id, email, emoji, created_at,
          PRIMARY KEY (message_id, email, emoji))
```

每次寫入後修剪:只留最近 500 則,連同其 reactions 一起刪。

### WS 協定(JSON)

Client → Server:
- `{type:"send", text, mentions:[emails], mentionAll:bool, replyTo?:id}`
  (text ≤ 2000 字;replyTo 由 server 快照 `reply_name`/`reply_snippet`)
- `{type:"react", id, emoji}` — toggle;emoji 限固定調色盤 👍❤️😂😮🙏🔥🎉
- `{type:"history", before:id}` — 往前載 50 則

Server → Client:
- `{type:"init", messages:[...50], reactions:[{message_id,emoji,email}], online:[{email,name}]}`
- `{type:"message", message}`(廣播)
- `{type:"reaction", id, emoji, email, on:bool}`(廣播)
- `{type:"online", users:[{email,name}]}`(join/leave 時廣播)
- `{type:"history", messages, reactions}`(單發)

### 提及 → 通知

server 收到 send 時:`mentionAll` → 全體(查 D1 users);否則 `mentions[]`
與 users 表交集。扣掉發送者與**目前連線中**的人(他們已即時看到),
其餘每人插一列 `notifications(kind='chat_mention', actor_email, preview=前 120 字)`。

### Worker 路由與設定

- `GET /api/chat/ws`:走既有 authMiddleware;把 email + display_name
  (encodeURIComponent,header 只能 ByteString)塞進
  `X-Chat-Email`/`X-Chat-Name` 轉發給 DO stub。
- `wrangler.toml`:`[[durable_objects.bindings]] CHAT=ChatRoom` +
  `[[migrations]] tag="v1" new_sqlite_classes=["ChatRoom"]`
- `worker/index.ts` 需 `export { ChatRoom }`
- migration `0018_chat_notify.sql`:`ALTER TABLE users ADD COLUMN chat_notify TEXT NOT NULL DEFAULT 'mention'`
- `me.ts` PATCH 接受 `chat_notify`(白名單驗證)

## 前端

### `ChatProvider`(掛在已登入 App 層)

單一 WS 連線 + 指數退避重連(1s→30s)+ 30s ping。持有:
messages(升冪)、reactions(依 message_id 分組)、online、unread、toasts。
未在 `/chat` 頁時收到訊息 → unread++,並依偏好決定是否彈 toast:
`all`=每則、`mention`=僅 @我或 @all、`off`=不彈;自己的訊息永不彈。

### Toast(自製,零依賴)

右上角(手機置頂)小卡:頭像 + 名字 + 摘要,點擊 → `/chat`,5 秒自動消失。
scholarly 風格,無漸層。

### `/chat` 聊天大廳頁

- 版面:`h-[100dvh-header]` flex column;訊息卷軸區 + 底部輸入列;
  手機保留底部 5 格 nav(輸入列墊高避開),鍵盤彈出靠 `dvh` 自適應。
- 訊息:頭像、名字、時間、日期分隔線;回覆引用小塊(點擊捲到原文);
  reactions chips(`👍 3`,含我則高亮,點擊 toggle);hover/長按顯示
  「回覆」與「+」emoji 調色盤。
- 輸入:textarea,Enter 送出 / Shift+Enter 換行(手機用送出鈕);
  打 `@` 出選單:`@all`、成員(useUsers)、輸入數字時提示題號格式。
- 送出時前端抽取 mentions:`@display_name` → email、`(^|\s)@all` → mentionAll。
- **@題號**:渲染時 `@(\d{3}-\d{1,3})` → `<Link to="/q/114-010">`(補零到 3 位),
  純文字存放,與現有 question-ref 慣例一致。
- 頁首:在線人數、通知偏好三段切換(全部/僅@我/關閉 → PATCH /api/me)。

### 入口與整合

- Header 加 MessageCircle 圖示 + 未讀 badge(桌機手機都看得到)→ `/chat`
- 桌面 nav 加「聊天」項
- `NotificationBell` 認得 `chat_mention` kind,連到 `/chat`
- `vite.config.ts` `/api` proxy 加 `ws: true`(http-proxy 對 ws upgrade
  也會套 `headers`,X-Dev-Email 本地可用)
- `useMe` Me type 加 `chat_notify`

## 不做(YAGNI)

- 圖片/TipTap 訊息、已讀回條、多房間、訊息編輯刪除、瀏覽器推播
- 真 CRDT / typing indicator

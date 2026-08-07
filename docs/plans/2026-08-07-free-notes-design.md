# 其他筆記(自由筆記)— 設計

日期:2026-08-07
分頁位置:`/lectures?tab=note`(複習班講義 / Wintrobe 教科書 旁的第三個分頁)

## 這是什麼

一則**不掛在任何題目上**的私人筆記。既有的 `personal_notes` 必須有
`question_id`,所以「讀到一個跟任何一題都對不上的概念」沒有地方寫 —— 只能
硬塞進某一題底下,之後就再也找不到。這個分頁補的是那個洞。

三件事讓它不只是一個記事本:

1. 內文可以用 `@114-010` 直接連到題目(跟聊天大廳同一個手勢)
2. Workers AI 依內容產標籤,語彙跟題庫的 `question_tags` 對齊
3. 下方掛既有的關聯建議系統 —— 相關題目、自己的其他筆記

## 可見範圍:私人

跟 `personal_notes` 同一條隱私紅線 —— 別人的自由筆記永遠看不到。這讓
`0030`(筆記關聯連結)那套「只連自己的筆記 + 公開題目」的閘門原封不動就能用,
不需要重新設計任何權限判斷。

不做 `visibility` 欄位。共筆已經有共筆詳解那條路;在這裡再開一條會讓建議系統
的隱私判斷從「一個 `user_email = ?`」變成跨表的可見性計算,而換到的東西
現有功能已經提供。

## 為什麼要新開一張表,而不是複用 `personal_notes`

```sql
personal_notes.question_id TEXT NOT NULL REFERENCES questions(id)
```

外鍵擋死了「用一個假題號當佔位」這條路;要走的話得先在 `questions` 裡插一列
假題目,那會汙染題數統計、隨機出題、匯出 —— 全部都是 `SELECT ... FROM
questions`。新開表比較便宜。

## 資料模型

### 新表

```sql
CREATE TABLE free_notes (
  id           TEXT    PRIMARY KEY,   -- 短亂數 id(不是流水號 —— 出現在網址上)
  user_email   TEXT    NOT NULL REFERENCES users(email) ON DELETE CASCADE,
  title        TEXT    NOT NULL DEFAULT '',
  content_json TEXT    NOT NULL,      -- TipTap ProseMirror JSON
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  needs_relink INTEGER NOT NULL DEFAULT 0,  -- 建議待重算
  tagged_hash  TEXT                          -- 上次產標籤時的內容雜湊
);

CREATE TABLE free_note_tags (
  note_id    TEXT NOT NULL REFERENCES free_notes(id) ON DELETE CASCADE,
  tag        TEXT NOT NULL,
  source     TEXT NOT NULL,   -- 'ai' | 'user'
  created_at INTEGER NOT NULL,
  PRIMARY KEY (note_id, tag)
);
```

`tagged_hash` 而不是 `needs_retag` 旗標:旗標會被「存檔 → 還沒產標籤 → 又存檔
回原內容」騙到,雜湊不會。而且它同時回答了「要不要重跑」與「跑的是哪一版」。

### 既有兩張表要一般化

`note_terms` 與 `note_link_suggestions` 現在的鍵是 `(user_email, question_id)`。
自由筆記沒有 `question_id`,所以把「擁有者」明確化:

```
note_terms:            (user_email, owner_kind, owner_id, term)
note_link_suggestions: (user_email, owner_kind, owner_id, target_kind, target_id)
```

`owner_kind ∈ {'question', 'free'}`;`target_kind ∈ {'question', 'note', 'free'}`
(`note` = 自己掛在某題下的筆記,維持原意)。

**不用 `question_id` 欄位塞自由筆記 id。** 兩者格式不會撞(`114-001` vs 亂數),
所以能動 —— 但那會讓欄名說謊,而這兩張表的每一條 SQL 都靠欄名讀懂。`0036` 已經
示範過重建表的做法,照著做。

代價是 `note-links.ts` 與 `notes.ts` 約十處呼叫點要跟著改。換到的是**單一程式
路徑**:自由筆記與題目筆記互相推薦是同一段 SQL,不是兩套。

`notes.ts` 讀取端目前是 `JOIN questions q ON q.id = s.target_id` —— 這條 join
會把自由筆記目標**靜默丟掉**。改成依 `target_kind` 分別 join,`free` 的走
`free_notes`(且必須 `AND user_email = ?`,否則會漏出別人的標題)。

## 標籤:存檔時記帳,讀取時惰性產生

寫入端只算內容雜湊,不呼叫 AI —— 打字中的 debounce 存檔一秒好幾次,在那裡
呼叫 Workers AI 會把免費額度(10K neurons/日)燒在沒人看的中間狀態上。

`GET /api/free-notes/:id/tags` 才是產生點:雜湊與 `tagged_hash` 不同時,呼叫
`buildSuggestTagsSystemPrompt()`(與 `/api/ai/suggest-tags` 同一套提示詞,所以
語彙跟題目標籤天然對齊),寫入 `source='ai'` 的列,更新 `tagged_hash`。

標籤獨立於筆記本體取得,詳情頁才不會為了等 AI 多花一兩秒;標籤區先顯示骨架。

**刪除要留墓碑,不能真的刪列。** 重跑只 `DELETE ... WHERE source='ai'` 再
`INSERT OR IGNORE`,所以「使用者刪掉的標籤不會回來」這件事不能靠「重跑時不動
`source='user'`」達成 —— 被刪掉的那個標籤根本不在表裡,模型看同一份內容會再
給出同一個標籤,它就回來了。因此刪除是把該列改成 `source='hidden'`:墓碑佔著
主鍵,`INSERT OR IGNORE` 撞上就跳過。讀取端過濾掉 `hidden`,重新手動加回來則
用 `INSERT OR REPLACE` 蓋掉墓碑。

夜間 cron 不補跑標籤。沒人打開的筆記不需要標籤,補跑只是把額度花在沒人看的
東西上。

## 建議系統

`note_terms` 的詞一律走既有的受控詞表(`extractTerms(text, vocab)`,vocab =
`DISTINCT question_tags`),AI 標籤只有恰好落在詞表裡的才會進去。理由是評分要
可比:`keyword_vocab.idf` 是照題庫算的,自由詞進來沒有 idf 只能吃
`COALESCE(idf, 0.5)` 的預設值,會讓罕見的自創詞跟「Richter transformation」
一樣重。

抽詞的輸入是 `title + 內文純文字 + AI 標籤`。

建議目標三種:公開題目、自己掛在題目下的筆記、自己的其他自由筆記。
**不含講義 / 教科書頁面** —— 那是 FTS 而非受控詞表,是另一套評分,YAGNI。

重算時機沿用 `0030`:存檔標 `needs_relink=1`,讀 `/links` 時髒了就當場算
(確定性 SQL,零 neuron),夜間 cron `drainRelinkQueue()` 當後盾。cron 的
「取最舊未算」查詢要 union 兩種擁有者。

## 畫記(即「我的畫記」收藏)

沿用既有機制,一列 schema 都不用加。`highlights` 表本來就是
`(user_email, store_key, content_hash, doc_json)` 的泛用鍵值,題目詳解用
`anno:exp:<qid>`、題目筆記用 `anno:note:<qid>:<slot>`;自由筆記用
**`anno:free:<id>:<hash>`**。

- 編輯器下方的唯讀檢視走 `NoteContent`,`annotateKeyPrefix={`anno:free:${id}`}`
  —— 跟 `Question.tsx:1740` 同一個呼叫形狀。螢光筆按鈕來自全站唯一的
  `SelectionToolbar`,不用再做浮層。
- 收藏頁「我的畫記」再撈一次 `?prefix=anno:free:`,與既有的 `anno:note:` 結果
  併排顯示。

`noteHighlights.ts` 的 `HlGroup` 目前寫死 `{ qid, year, number }` —— 那是題目
才有的欄位。改成帶 `kind`:題目畫記維持原樣,自由筆記那組帶 `{ kind:'free',
id, title }`。收藏頁用 `kind` 決定連去 `/q/:id` 還是 `/notes/:id`。

`export-scope.ts` 把 `store_key` 反解成題號來決定匯出範圍,它的條件是
`LIKE 'anno:note:' || q.id || ':%'` —— `anno:free:` 天然不匹配,匯出不會被
汙染,不用改。

## API

```
GET    /api/free-notes             列表(id、title、摘要、標籤、updated_at)
POST   /api/free-notes             新增,回傳 id
GET    /api/free-notes/:id         單則
PUT    /api/free-notes/:id         存檔(title、content_json)
DELETE /api/free-notes/:id         刪除(連帶清 tags / terms / suggestions)
GET    /api/free-notes/:id/tags    標籤(髒了就惰性產生)
POST   /api/free-notes/:id/tags    手動加一個(source='user')
DELETE /api/free-notes/:id/tags?tag=  手動刪一個(寫 'hidden' 墓碑)
GET    /api/free-notes/:id/links   關聯建議
```

每條都以 `c.var.email` 為界。`:id` 是亂數但**不當作機密**:每次查詢都帶
`user_email = ?`,猜到 id 也讀不到。

## 前端

- `Lectures.tsx`:`LectureView` 加 `"note"`,分頁列加「其他筆記」,
  `?tab=note`。卡片格線沿用 `LectureCard` 的視覺語言(同樣的 border /
  hover:border-accent / 底部 metadata 列),內容換成標題、摘要、標籤 chips。
- 搜尋框在這個分頁**改成前端過濾**已載入的卡片(標題 / 標籤 / 純文字)。
  不開新的 FTS 端點:私人筆記數量是幾十則的量級,拉回來過濾比建索引便宜,
  而且立即。scope 切換(PDF 內文 / 筆記)在這個分頁隱藏。
- 新路由 `/notes/:id` → `FreeNote.tsx`:標題輸入、標籤 chips、`RichEditor`、
  下方建議區。`RichEditor` 已經內建 `QuestionRef` 與 mention suggestion,
  所以 `@114-010` 與 `@人名` 不需要任何新程式。
- `NoteContent` 的章節手風琴預設收合 —— 那對題目頁的側欄面板是對的(筆記是
  次要內容),對這個專屬頁是錯的(整頁只有這一則,收合著等於打開自己的筆記
  只看到幾個標題)。加 `defaultSectionsOpen` 參數,預設維持 false,只有這裡
  傳 true;既有呼叫端一行未動。
- 「你可能想連結」抽成 `components/NoteLinkList.tsx`。抽出來不是為了省行數:
  `targetKind` 現在有三種,而 `free` 的 `targetId` 是 UUID 不是題號 —— 兩邊
  各自渲染的話,漏掉一邊就生出 `/q/<uuid>` 這種連到不存在題目的死連結
  (題目頁原本的寫法正是無條件 `to={/q/${targetId}}`)。

### 不能踩的兩個坑

- **`/api/free-notes*` 不進 `sw-guards.ts` 的 `CACHEABLE_API`。** 可變的私人
  狀態被 SW 快取住,使用者會看到自己剛存的東西沒有變。
- **卡片列表不要就地展開成編輯器。** 在 grid 裡掛 / 卸 TipTap 正是
  2026-07 iOS 白屏那個 `useEditor` 競態的溫床(見 CLAUDE.md PWA 段)。
  獨立頁 `/notes/:id` 一頁一個 editor,重掛時機單純。

## 測試

- `note-terms` / 一般化後的鍵:既有單元測試要跟著改,並補「自由筆記與題目
  筆記互相推薦」一則。
- e2e:`/notes/:id` 要加 fixture(`frontend/e2e/fixtures/`),否則 WebKit
  煙霧測試拿到 `{}`。列表頁走 `/lectures?tab=note` 現有 fixture 路徑。
- `pnpm test:webkit` 必跑 —— 這頁有 TipTap。

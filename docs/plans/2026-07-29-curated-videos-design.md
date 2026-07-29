# 策展 YouTube 教學影片

**日期**:2026-07-29
**狀態**:設計定案,待實作

每題除了題幹、答案、共筆詳解、個人筆記之外,再給一個「影片」tab:
一份人工把關過的 YouTube 教學影片清單,讓看完詳解還是不懂的人有地方去。

---

## 為什麼不是「每題一份播放清單」

第一個想法是每題策展一份。實際看過資料後放棄:

- 1000 題各搜一次,是 1000 次搜尋與 1000 次人工把關;
- 同主題的題目(光 AML 就 91 題)會反覆收到同一批影片,勞動完全重複;
- 影片的粒度本來就是「主題」——「CML 的病生理」是一支影片,
  「114-023 這題」不是。

所以影片掛在**主題**上,題目透過自己的 tag 命中主題。

## 為什麼不能直接用 `question_tags`

現有標籤是共筆自由填的,實測(2026-07-29,本機 D1):

| 指標 | 數值 |
|---|---|
| 不同 tag 數 | 853 |
| 只出現 1 次的 tag | 588 |
| 出現 ≥5 次的 tag | 109 |
| 有 tag 的題目 | 977 / 1000 |

問題不只是長尾。標籤裡混了三種東西:

1. **真主題**:`AML`、`CML`、`TTP`、`vWD`
2. **面向而非主題**:`治療`(85)、`診斷`(41)、`預後`(13) —— 搜「治療」會得到垃圾
3. **工作流標記**:`低信心需覆核`(70)、`待補選項`(21)、`答案待確認`(11)

外加中英重複(`lymphoma`/`淋巴瘤`、`transfusion`/`輸血`)與同義異寫
(`vWD`/`VWD`/`血友病`)。

結論:**主題是另一個軸**,用一張映射表把髒 tag 接上去。

---

## 資料模型

```sql
-- migration 0035_videos.sql

CREATE TABLE video_topics (
  slug       TEXT PRIMARY KEY,   -- 'cml'
  label      TEXT NOT NULL,      -- 'CML 慢性骨髓性白血病'
  kind       TEXT NOT NULL,      -- 'treatment' | 'mechanism'
  query      TEXT NOT NULL,      -- 餵給 yt-dlp 的搜尋詞
  created_at INTEGER NOT NULL
);

CREATE TABLE tag_topics (          -- 髒 tag → 主題,多對多
  tag        TEXT NOT NULL,
  topic_slug TEXT NOT NULL REFERENCES video_topics(slug) ON DELETE CASCADE,
  PRIMARY KEY (tag, topic_slug)
);

CREATE TABLE videos (
  id           TEXT PRIMARY KEY,  -- YouTube videoId
  title        TEXT NOT NULL,
  channel      TEXT NOT NULL,
  channel_id   TEXT,
  duration_s   INTEGER NOT NULL,
  view_count   INTEGER NOT NULL,
  upload_date  TEXT,              -- 'YYYYMMDD'
  thumb_key    TEXT,              -- R2 key
  ai_score     INTEGER,           -- 0–10
  ai_reason    TEXT,              -- 一句話推薦理由,顯示在卡片上
  status       TEXT NOT NULL DEFAULT 'ok',   -- 'ok' | 'removed' | 'dead'
  removed_by   TEXT,
  removed_at   INTEGER,
  refreshed_at INTEGER NOT NULL,
  created_at   INTEGER NOT NULL
);

CREATE TABLE topic_videos (
  topic_slug TEXT NOT NULL REFERENCES video_topics(slug) ON DELETE CASCADE,
  video_id   TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  rank       INTEGER NOT NULL,
  PRIMARY KEY (topic_slug, video_id)
);
```

三個決定值得記下來:

**沒有 `question_videos`。** 題目到影片走
`question_tags → tag_topics → topic_videos → videos` 這條 join 鏈。
之後有人幫題目補一個 tag,影片自動生效,不必重跑策展腳本。代價是多兩層
join,在 1000 題的規模下量不出來。

**`videos` 全域唯一,一支影片可掛多個主題。** 所以「任何人可刪、全域生效」
就只是把 `status` 設成 `removed` —— 一次刪乾淨,而且是軟刪除,留下操作者
與時間,可復原。

**`ai_reason` 存下來而不只是拿來過濾。** 卡片上顯示「為什麼推薦這支」,
在 20 人的讀書會裡這比觀看數有說服力。

---

## 策展流程

離線跑,由 Claude Code 驅動(同 `enrich-note` 的模式),不是站上的 runtime 功能。

| 階段 | 做什麼 |
|---|---|
| **P0** 一次性 | 讀出全部 853 個 tag,正規化合併成約 100 個主題,標 `kind` 與搜尋詞,產出 `scripts/video-topics.json` 供審閱後匯入 |
| **P1** 搜尋 | 每主題 `yt-dlp "ytsearch25:<query>" --flat-playlist`,時長過濾 5–40 分,依 `view_count` 取前 12 支候選 |
| **P2** 補齊 | 候選逐支 `--dump-json` 取 `upload_date` / `description` / `availability`,套年限門檻 |
| **P3** 把關 | 候選丟 Haiku subagent 批次評分,回 `{score, reason, is_teaching}`;`score<6` 或非教學內容丟掉,每主題留前 8 支 |
| **P4** 縮圖 | `hqdefault.jpg` → R2 `video-thumbs/<id>.jpg` |
| **P5** 寫入 | 批次 upsert 到 remote D1 |

**年限門檻依主題類別分開**,因為兩種內容的半衰期差很多:

- `kind='treatment'`(藥物、方案、指引):**5 年**
- `kind='mechanism'`(病生理、細胞遺傳、實驗室判讀):**12 年**

**沒有 YouTube Data API key。** 用 `yt-dlp`。實測(2026-07-29):

- `ytsearch25:<query>` 約 2 秒,拿得到 `id/title/channel/duration/view_count`,
  但 **flat 模式沒有上傳日期**
- 單支 `--dump-json` 約 1.5 秒,才有 `upload_date`、`description`
  (餵 AI 評分用)、`channel_follower_count`、`availability`

全庫估時約 35 分鐘 + 評分時間。

**`--refresh` 模式**跳過 P1–P3,只重抓既有影片的 metadata;
`availability != public` 就標 `dead`,前端自動不顯示,不需人工介入。

---

## API

`worker/routes/videos.ts`:

```
GET    /api/questions/:id/videos   → [{topic:{slug,label}, videos:[...]}]
GET    /api/videos/topics          → 影片庫首頁
GET    /api/videos/topics/:slug
DELETE /api/videos/:id             → 軟刪除,任何登入者,記 removed_by
POST   /api/videos/:id/restore
```

只回 `status='ok'` 的影片,依 `rank` 排序。縮圖走現有 `/img/<key>` 代理,
`images.ts` 零改動 —— R2 bucket 維持非公開,Zero Trust 邊界不破。

---

## 前端

- `Question.tsx` 的 `Tab` / `MainTab` 型別加 `"video"`;tabs 模式變 6 個,
  `n` 鍵循環自動含入。**有影片才渲染該 tab**,badge 顯示總數
- tab 內依主題分組(`CML (8)`、`TKI 抗藥 (8)`…),每組預設展開前 3 支
- `VideoCard`:16:9 縮圖 + 標題 + 頻道 + 時長 + 觀看數 + `ai_reason`,
  右上角 hover 出現刪除鈕(需二次確認)
- 點縮圖 → 就地替換成 `<iframe src="youtube-nocookie.com/embed/<id>">`,
  **lazy,不預載**
- `/videos` 主題瀏覽頁,可搜尋,也是清垃圾的地方

**`frontend/public/_headers` 必須加 `frame-src https://www.youtube-nocookie.com`。**
現行 CSP 沒有 `frame-src`,會 fallback 到 `default-src 'self'`,YouTube iframe
會被直接擋掉。

**Service Worker**:`/api/questions/:id/videos` 加進 `CACHEABLE_API`
(唯讀、變動極少)。離線時卡片仍顯示,點播放給提示 —— iframe 本來就需要網路。

---

## 風險與明確不做

- **yt-dlp 會被 YouTube 反制而壞掉。** 只影響離線腳本,站上既有資料不受影響。
  這是不申請 API key 的代價,接受。
- **免費層**:R2 縮圖約 100 主題 × 8 支 × 20KB ≈ **16MB**。無新增 Worker 成本。
- **嵌入合規**:用 `youtube-nocookie.com/embed`,是 YouTube 官方嵌入端點。

不做:字幕全文檢索、時間戳深連結、觀看進度追蹤、使用者自行貼影片、影片投票。

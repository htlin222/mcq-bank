-- ============================================================
-- Migration 0035: 策展 YouTube 教學影片
--
-- 影片掛在「主題」上,不掛在題目上。1000 題各策展一份是 1000 次重複
-- 勞動(光 AML 就 91 題會收到同一批影片),而影片本來的粒度就是主題。
--
-- 主題不能直接沿用 question_tags:那裡有 853 個不同標籤、588 個只出現
-- 一次,還混了「治療」「診斷」這種面向標籤(搜出來全是垃圾)與
-- 「低信心需覆核」「待補選項」這種工作流標記。所以主題另立一軸,
-- 用 tag_topics 把髒 tag 接上去。
--
-- 題目 → 影片的查詢路徑:
--   question_tags → tag_topics → topic_videos → videos
-- 沒有 question_videos 表。之後有人幫題目補一個 tag,影片自動生效,
-- 不必重跑策展腳本。
-- ============================================================

-- 正規化主題。策展腳本以此為單位搜尋 YouTube。
CREATE TABLE video_topics (
  slug       TEXT    PRIMARY KEY,          -- 'cml'
  label      TEXT    NOT NULL,             -- 顯示名,例 'CML 慢性骨髓性白血病'
  kind       TEXT    NOT NULL,             -- 'treatment' | 'mechanism'
  query      TEXT    NOT NULL,             -- 餵給 yt-dlp 的搜尋詞
  created_at INTEGER NOT NULL
);

-- kind 決定影片的年限門檻:治療類(藥物/方案/指引)5 年內,
-- 機轉類(病生理/細胞遺傳/實驗室判讀)12 年內。兩者半衰期差很多。

-- 髒 tag → 主題。多對多:一個主題吃多個同義 tag
-- (vWD / VWD / 血友病),一個 tag 也可歸到多個主題。
CREATE TABLE tag_topics (
  tag        TEXT NOT NULL,
  topic_slug TEXT NOT NULL REFERENCES video_topics(slug) ON DELETE CASCADE,
  PRIMARY KEY (tag, topic_slug)
);

CREATE INDEX idx_tag_topics_topic ON tag_topics(topic_slug);

-- 影片本體。全域唯一 —— 一支影片可掛多個主題,所以「刪掉這支爛影片」
-- 是一次全域生效,而不是逐主題刪。
CREATE TABLE videos (
  id           TEXT    PRIMARY KEY,        -- YouTube videoId
  title        TEXT    NOT NULL,
  channel      TEXT    NOT NULL,
  channel_id   TEXT,
  duration_s   INTEGER NOT NULL,
  view_count   INTEGER NOT NULL,
  upload_date  TEXT,                       -- 'YYYYMMDD',flat 搜尋拿不到,需補抓
  thumb_key    TEXT,                       -- R2 key,走 /img/ 代理(bucket 不公開)
  ai_score     INTEGER,                    -- 0–10,Haiku 相關性評分
  ai_reason    TEXT,                       -- 一句話推薦理由,顯示在卡片上
  status       TEXT    NOT NULL DEFAULT 'ok',
                                           -- 'ok'      正常
                                           -- 'removed' 使用者刪除(軟刪,可復原)
                                           -- 'dead'    來源已下架,refresh 時自動標記
  removed_by   TEXT,                       -- email,誰刪的
  removed_at   INTEGER,
  refreshed_at INTEGER NOT NULL,           -- metadata 最後一次重抓的時間
  created_at   INTEGER NOT NULL
);

CREATE INDEX idx_videos_status ON videos(status);

CREATE TABLE topic_videos (
  topic_slug TEXT    NOT NULL REFERENCES video_topics(slug) ON DELETE CASCADE,
  video_id   TEXT    NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  rank       INTEGER NOT NULL,             -- 策展腳本決定的組內順序,1 起
  PRIMARY KEY (topic_slug, video_id)
);

CREATE INDEX idx_topic_videos_video ON topic_videos(video_id);

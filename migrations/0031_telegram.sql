-- ============================================================
-- Migration 0031: Telegram 出題機器人
--
-- 綁定既有帳號(chat_id ↔ email)、每日推播設定、聊天內作答/測驗的
-- session 狀態(Worker 無狀態,故存 D1)。作答不另建進度表 —— 直接寫
-- 既有 review_progress + attempts;FSRS 到期查詢僅讀 fsrs_cards。
-- ============================================================

CREATE TABLE tg_users (
  chat_id      INTEGER PRIMARY KEY,            -- Telegram 私聊 id (= user id)
  email        TEXT REFERENCES users(email) ON DELETE CASCADE, -- NULL = 未綁定
  username     TEXT,
  first_name   TEXT,
  subscribed   INTEGER NOT NULL DEFAULT 1,     -- 每日推播開關
  push_hour    INTEGER NOT NULL DEFAULT 8,     -- 本地時 0-23
  tz_offset    INTEGER NOT NULL DEFAULT 480,   -- 分鐘,UTC 以東(台北 +480)
  year_filter  INTEGER,                        -- NULL = 全部年份
  daily_count  INTEGER NOT NULL DEFAULT 1,     -- 每次每日推播題數
  last_push_on TEXT,                           -- 'YYYY-MM-DD' 本地日期,防重推
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE INDEX idx_tg_users_email ON tg_users(email);
CREATE INDEX idx_tg_users_push ON tg_users(subscribed, push_hour);

-- 一次性綁定碼:app 內產生,deep link ?start=<code> 帶回。
CREATE TABLE tg_link_codes (
  code        TEXT PRIMARY KEY,   -- base32 隨機
  email       TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,   -- 建立後 15 分鐘
  used_at     INTEGER             -- 單次使用;非 NULL 即作廢
);

CREATE INDEX idx_tg_link_codes_email ON tg_link_codes(email);

-- 每個 chat 的當前互動狀態(當前題目 / 小測驗剩餘題)。
CREATE TABLE tg_sessions (
  chat_id     INTEGER PRIMARY KEY,
  kind        TEXT NOT NULL,      -- 'daily' | 'quiz'
  data_json   TEXT NOT NULL,      -- {qid, remaining:[], score, total, year}
  updated_at  INTEGER NOT NULL
);

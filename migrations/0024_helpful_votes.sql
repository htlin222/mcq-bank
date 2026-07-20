-- Migration 0024: 「有幫助」訊號 (helpful votes)
-- 一人對一個 target 一票。PK 即冪等保證:重複 INSERT 走 ON CONFLICT
-- DO NOTHING,計數不會重複;撤回 = DELETE。target_type 目前只允許
-- 'comment'(API 層白名單)。共筆詳解刻意不投票 —— 詳解是單列可覆寫的
-- 活文件,票會存活於它所背書的內容之外,成為誤導訊號。
CREATE TABLE helpful_votes (
  user_email   TEXT    NOT NULL REFERENCES users(email),
  target_type  TEXT    NOT NULL,          -- 'comment'
  target_id    TEXT    NOT NULL,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (user_email, target_type, target_id)
);

CREATE INDEX idx_helpful_target ON helpful_votes(target_type, target_id);

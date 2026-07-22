-- ============================================================
-- Migration 0031: 請求去重 (request idempotency)
--
-- 全站沒有統一的 Idempotency-Key 機制,所有 append / increment /
-- 外部副作用端點在 client 或中間層重送同一個 POST 時就會重複寫入。
-- 這張表把「一次使用者動作」記成一列,重送時 replay 既有回應、
-- 完全跳過寫入。詳見 docs/plans/2026-07-21-idempotency-audit.md。
--
-- 向後相容:沒帶 Idempotency-Key 的請求完全不碰這張表,行為與現況一致。
-- ============================================================

CREATE TABLE request_dedup (
  client_id     TEXT PRIMARY KEY,    -- 命名空間化後的 key:`${email}:${key}`
  user_email    TEXT NOT NULL,
  endpoint      TEXT NOT NULL,       -- 例如 'POST /review/answer'
  status        INTEGER NOT NULL,    -- replay 時要還原的 HTTP 狀態碼
  response_json TEXT NOT NULL,       -- replay 時要還原的 body(已 JSON 序列化)
  created_at    INTEGER NOT NULL
);

-- cron 過期清理(7 天前的列)掃 created_at。
CREATE INDEX idx_request_dedup_created ON request_dedup(created_at);

-- ============================================================
-- Migration 0018: chat lobby notification preference
-- 'all'     — toast on every lobby message
-- 'mention' — toast only when @me or @all (default)
-- 'off'     — no toasts
-- Chat messages themselves live in the ChatRoom Durable Object's
-- SQLite storage (last 500), not in D1.
-- ============================================================

ALTER TABLE users ADD COLUMN chat_notify TEXT NOT NULL DEFAULT 'mention';

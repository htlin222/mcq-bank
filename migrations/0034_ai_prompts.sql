-- ============================================================
-- Migration 0034: BYOK AI 助手 —— 使用者自訂提示詞
--
-- 選字工具列上的「✨ AI」跑的是使用者自己的提示詞。金鑰(Groq API key)
-- 只存在瀏覽器 localStorage,永遠不進這裡 —— 這張表只有提示詞本身,
-- 這樣才能跨裝置共用提示詞而不必把金鑰交給伺服器。
--
-- 四個內建預設(ELI5 / 助記 / 大綱 / 必考重點)寫死在前端程式碼
-- (frontend/src/lib/aiPrompts.ts),不 seed 進來:沒有 seed 就沒有
-- 「還原預設」這種狀態要維護,也不會每個使用者複製四份一模一樣的列。
--
-- body 內可用 {{selection}}(選取文字)與 {{context}}(所在段落),
-- 前端送出前替換。
-- ============================================================

CREATE TABLE ai_prompts (
  id         TEXT    PRIMARY KEY,             -- uuid
  user_email TEXT    NOT NULL REFERENCES users(email),
  title      TEXT    NOT NULL,                -- 工具列上的按鈕名
  body       TEXT    NOT NULL,                -- 提示詞本體
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_ai_prompts_user ON ai_prompts (user_email, sort_order, created_at);

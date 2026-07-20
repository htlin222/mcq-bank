-- ============================================================
-- Migration 0023: 逐次作答歷史 (attempts event log)
--
-- 在此之前只有聚合值:review_progress 累加 times_seen/times_correct,
-- exam_answers 以 (session_id, question_id) 為主鍵被後續作答覆寫,
-- 兩者都答不出「這題第幾次作答、花了多久」。
--
-- attempts 是 append-only 事件流,自此為作答的唯一真相;
-- review_progress 的聚合欄位降級為 derived cache(仍雙寫,因為它
-- 同時存 bookmark),exam_answers 仍是模擬考的當前作答狀態。
--
-- 職責切分:
--   attempts          唯一真相,每次作答一列,append-only,不 UPDATE
--                     (例外:模擬考交卷時回填 is_correct)
--   review_progress   derived cache(聚合 + bookmark);bookmarked /
--                     bookmark_folder_id 不是 derived,仍是真相
--   exam_answers      模擬考「當前作答狀態」(可覆寫、供 resume 與計分)
--   confidence_events 信心事件流,本計畫不合併
--   fsrs_review_logs  FSRS 排程審計軌跡,與 MCQ 作答正交
--
-- 不回填歷史:舊資料只有聚合值,展開成假時間戳會汙染唯一真相。
--
-- elapsed_ms:前端量測的「實際看著這題的毫秒數」,分頁隱藏期間
-- 不計(frontend/src/lib/questionTimer.ts),伺服器再夾到 [0, 30分鐘]。
-- ============================================================

CREATE TABLE attempts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_email  TEXT    NOT NULL REFERENCES users(email) ON DELETE CASCADE,
  question_id TEXT    NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  chosen      TEXT,                 -- 'A'..'E';NULL = 未作答(交卷時的空題)
  is_correct  INTEGER,              -- 0/1;NULL = 尚未判定(模擬考交卷前)
  source      TEXT    NOT NULL,     -- 'review' | 'exam' | 'drill' | 'anki'
  session_id  TEXT,                 -- exam_sessions.id;非 exam 來源為 NULL
  elapsed_ms  INTEGER,              -- 夾值後的單題耗時;NULL = 未回報
  created_at  INTEGER NOT NULL
);

-- 個人時間軸(學習曲線、配速摘要、heatmap 逐次計數)
CREATE INDEX idx_attempts_user_time ON attempts (user_email, created_at DESC);
-- 單題全體耗時分佈(中位數 / 百分位)
CREATE INDEX idx_attempts_question ON attempts (question_id, elapsed_ms);
-- 一場模擬考的逐題耗時(檢討頁 + 前後半段對比)
CREATE INDEX idx_attempts_session ON attempts (session_id, created_at);

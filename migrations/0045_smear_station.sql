-- ============================================================
-- Migration 0045: 抹片跑台模組(smear station)
--
-- 設計:docs/plans/2026-09-09-smear-station-design.md
--
-- 一個「案例」= 一個病人的一組片子,從臨床病史開始,逐張揭露,最後才問診斷。
-- 它跟單張填空題的關係是:一個病人跟一張圖一樣,都是「那個診斷的一個實例」。
--
-- ⚠️ 答案共用 smear_dx,不另開一套詞彙。理由是「同一診斷多種版本」——
--    CLL 的案例跟 CLL 的單張圖必須是同一個東西,否則兩者串不起來,而那正是
--    這個模組被要求做出來的原因。判定直接沿用 gradeSmear() 比對 smear_terms。
--
-- ⚠️ smear_cases.id 不准內嵌 dx slug。ASH 那批的 'ash-hairy_cell_leukemia-63662'
--    原樣送到前端就是洩答(#223 踩過),clientQuestionId() 就是為它存在的。
--    這裡用 deck + 序號,讓那個問題從源頭不存在,而不是再加一層防護。
--
-- ⚠️ 沒有 title 欄位,這是刻意的。投影片上的標題是 'Case 3: ALL vs. FL?' ——
--    它含答案。存進來就一定有某一支端點會順手把它送出去。不存就沒有這個風險。
-- ============================================================

CREATE TABLE smear_cases (
  id              TEXT PRIMARY KEY,   -- 'kfs-l5-c3';不得內嵌 dx slug
  dx_id           TEXT NOT NULL REFERENCES smear_dx(id) ON DELETE CASCADE,
  history_md      TEXT,               -- 臨床病史:年齡/主訴/CBC/生化。開場就給
  discussion_json TEXT,               -- 揭曉後的整案討論(TipTap JSON)
  source          TEXT NOT NULL,      -- kfs|ash
  source_ref      TEXT,               -- 'Smear-5.pdf#Case3'
  attribution     TEXT,
  created_at      INTEGER NOT NULL
);
CREATE INDEX idx_smear_cases_dx ON smear_cases(dx_id);
CREATE INDEX idx_smear_cases_source ON smear_cases(source);

-- 一張投影片頁 = 案例的一個步驟。
--
-- ⚠️ 步驟是「一張投影片頁」不是「一張嵌入圖」。實測 159 張嵌入圖散在 77 頁上,
--    一頁常常並排 PB 與 BM —— 所以 modality 允許逗號分隔的多值,而且不要為了
--    讓 PB→BM 的順序好看去裁圖。
--
-- ⚠️ caption 只存冒號的左半。投影片原文是 '2022/08/03 BM smear: suspect AML',
--    61 個帶日期的圖說裡有 24 個(39%)長這樣。左半是日期與模態,是要給的線索;
--    右半是判讀,存進 caption 等於把答案印在圖旁邊。右半進 reveal_note。
CREATE TABLE smear_case_items (
  case_id        TEXT NOT NULL REFERENCES smear_cases(id) ON DELETE CASCADE,
  idx            INTEGER NOT NULL,    -- 投影片本來的順序,不按模態重排
  modality       TEXT NOT NULL,       -- pb|bm|effusion|aspiration|other(可多值)
  image_key_view TEXT NOT NULL,
  image_key_full TEXT NOT NULL,
  caption        TEXT,                -- 揭曉前可見(冒號左半)
  reveal_note    TEXT,                -- 揭曉後才送(冒號右半 + 該頁說明)
  PRIMARY KEY (case_id, idx)
);

-- 一次跑台 = 一列。沒有 session、不計時、不交卷。
--
-- ⚠️ notes_json 是逐步的自由輸入,不判分。它存在的理由是揭曉時要把「你寫的」
--    跟「原文」並排 —— 中途完全不回饋,所以那一刻是使用者唯一一次看到自己
--    當初怎麼想的機會。
CREATE TABLE smear_case_attempts (
  id          TEXT PRIMARY KEY,
  user_email  TEXT NOT NULL REFERENCES users(email) ON DELETE CASCADE,
  case_id     TEXT NOT NULL REFERENCES smear_cases(id) ON DELETE CASCADE,
  notes_json  TEXT,
  final_typed TEXT,
  tier        TEXT,                   -- full|half|lay|miss
  score       REAL,
  steps_seen  INTEGER,                -- 看到第幾張才敢下診斷;client 自報,不計分
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_smear_case_attempts_user ON smear_case_attempts(user_email, created_at);
CREATE INDEX idx_smear_case_attempts_case ON smear_case_attempts(case_id);

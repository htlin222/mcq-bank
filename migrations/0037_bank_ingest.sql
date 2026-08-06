-- ============================================================
-- Migration 0037: 新年份題庫匯入(bank-ingest)
--
-- 設計文件:docs/plans/2026-08-06-new-year-ingest-design.md
--
-- 讓 ADMIN_EMAILS 裡的任何人從複習模式按一顆按鈕,下載特權 .skill,在本機把
-- PDF 解析成題庫,推進「暫存區」,再回瀏覽器逐題審閱後發布。
--
-- 這裡建的兩張表全是暫存區。真正的題庫仍然只在 questions / explanations /
-- question_tags —— 發布是一次 INSERT,失敗就整批不進去。
--
-- 為什麼要暫存區:下載下來的 .skill 帶著一把可以寫入的金鑰(bnkk_),那把
-- 金鑰只能寫這兩張表。就算 admin 的筆電被拿走,攻擊者最多塞一批髒資料進
-- import_staging,學員完全看不到;真正進 questions 那一步必須在 Access 認證
-- 過的瀏覽器裡按下去。特權 skill 的爆炸半徑因此接近零。
-- ============================================================

-- 一個年份的匯入工作。skill 每個階段回報一次,網頁精靈靠這列決定顯示到第幾步。
CREATE TABLE import_jobs (
  id             TEXT PRIMARY KEY,          -- uuid,由 Worker 產生
  year           INTEGER NOT NULL,          -- 民國年
  created_by     TEXT NOT NULL,             -- admin email
  -- ready → parsing → parsed → explaining → pushed → published
  -- 「作廢」不是一個 stage,是直接刪列(連帶 CASCADE 掉 import_staging),
  -- 因為作廢掉的暫存資料沒有任何人要看。
  stage          TEXT NOT NULL,
  detail         TEXT,                      -- 自由文字,給進度卡片顯示
  question_count INTEGER NOT NULL DEFAULT 0,
  needs_review   INTEGER NOT NULL DEFAULT 0, -- 缺答案或低信心的題數
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

-- 同一年份同時只能有一個進行中的 job。已發布的不算,所以同一年份重跑第二次
-- 要先作廢第一次 —— 這是刻意的:兩個人同時匯入同一年會互相蓋掉對方的暫存
-- 資料,寧可在這裡擋下來。
CREATE UNIQUE INDEX idx_import_jobs_live ON import_jobs(year)
  WHERE stage <> 'published';

CREATE INDEX idx_import_jobs_creator ON import_jobs(created_by, updated_at DESC);

-- 暫存的題目,一題一列。payload 的形狀刻意與 years/<year>/batches/*.json
-- 完全相同(number/group/stem/options/answer/tags/explanation_doc/confidence),
-- 這樣既有的 AGENT_SPEC 產物不用轉換就能推上來。
--
-- explanation 存的是 TipTap JSON 不是 markdown —— 轉換在本機 skill 做完,
-- Worker 端只驗結構,不必再帶一份 markdown parser 進 edge runtime。
CREATE TABLE import_staging (
  job_id  TEXT NOT NULL REFERENCES import_jobs(id) ON DELETE CASCADE,
  number  INTEGER NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (job_id, number)
);

-- bnkk_ 金鑰的版本鹽。與 mcq_key_version 分開,可以只撤銷寫入權而不影響
-- 那個人的 /mcq 讀題金鑰(反之亦然)。
ALTER TABLE users ADD COLUMN bank_key_version INTEGER NOT NULL DEFAULT 1;

-- 最後一次 doctor.py / skill 心跳。精靈 Step 2 靠它把「本機環境好了沒」
-- 從死說明變成活狀態 —— 更重要的是,它同時驗證了金鑰有效與網路可達,
-- 否則一把過期的金鑰要拖到最後推送時才炸,使用者已經白跑整個解析。
ALTER TABLE users ADD COLUMN bank_last_seen_at INTEGER;

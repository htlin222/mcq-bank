-- 個人筆記的自訂排序(#140)。
--
-- 為什麼不重用既有欄位:
--
--   slot        是 PK 的一部分,而且 highlights 的 store_key(anno:note:<qid>:<slot>)、
--               note_cloze、note_terms、note_link_suggestions 全都以它定位。拿它來
--               重排等於把畫記與挖空快取搬到別則筆記身上。
--   created_at  改寫它就是讓欄名說謊。而且「依建立順序排」正是 0036 加這個欄位的
--               理由,重排一次之後那個語意就沒了。
--
-- 既有列一律 0,而讀取端排 `sort_order, slot` —— 所以還沒重排過的人看到的順序
-- 跟以前一模一樣(slot 遞增 = 建立順序)。這是這個 migration 唯一的相容性保證,
-- 讀取端漏了第二個排序鍵的話,同分的列順序由 SQLite 自由決定,使用者會看到筆記
-- 每次重整都換位置。
ALTER TABLE personal_notes ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;

-- 讀取一律帶 user_email + question_id,排序鍵接在後面。
CREATE INDEX idx_notes_order
  ON personal_notes(user_email, question_id, sort_order, slot);

-- ============================================================
-- Migration 0042: 講義書籤 (per-user page bookmarks)
--
-- 閱讀器左側 rail 的第二個分頁,以及 /lectures?tab=bookmark 的卡片格線。
-- 一列 = 「某人在某份講義的某一頁插了旗子」。私有,跟 lecture_notes /
-- lecture_annotations 同一個 per-user 模型。
--
-- 頁碼存 1-based —— 這個 repo 裡兩種慣例已經並存:
--   lecture_notes.page        1-based (LecturePanel 的 pdfPage = currentPage + 1)
--   lecture_annotations.page  0-based (清單顯示寫的是 p.{a.page + 1})
-- 書籤卡片的預覽要 join lecture_notes 取同一頁的筆記,所以跟 join 對象一致,
-- 0/1 的轉換就只發生在 viewer 邊界那一處(LectureReader),不會散進 SQL 裡。
--
-- UNIQUE(user_email, slug, page) 是承重的,不是整潔:工具列那顆是 toggle,
-- 「同一頁只有一筆」正是它的前提。少了唯一鍵,連點兩下會寫出兩列一模一樣的
-- 資料,而畫面上只是「書籤清單多了一行重複的」—— 看不出是寫入壞掉。
--
-- 只給 kind='lecture' 用(教科書唯讀,建立端點會擋)。這裡不下 CHECK:
-- kind 在 lecture_docs 上,SQLite 的 CHECK 碰不到別的表。
-- ============================================================

CREATE TABLE lecture_bookmarks (
  id         TEXT PRIMARY KEY,
  user_email TEXT NOT NULL REFERENCES users(email) ON DELETE CASCADE,
  slug       TEXT NOT NULL REFERENCES lecture_docs(slug) ON DELETE CASCADE,
  page       INTEGER NOT NULL,          -- 1-based PDF 頁碼
  created_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX idx_lecbm_uniq ON lecture_bookmarks(user_email, slug, page);

-- 首頁分頁預設「日期新→舊」,rail 則是單一 slug 依頁碼。兩條查詢各一個索引。
CREATE INDEX idx_lecbm_user_created ON lecture_bookmarks(user_email, created_at);
CREATE INDEX idx_lecbm_user_slug_page ON lecture_bookmarks(user_email, slug, page);

-- 畫記頁碼改 1-based 的 expand。
--
-- lecture_annotations.page 存的是 EmbedPDF 的 0-based pageIndex。
-- 不就地 UPDATE page = page + 1:舊程式還把 page 當 viewer index,
-- 清單又另外 + 1。就地改語意會讓那一頁再被加一次,跳到隔壁頁。
-- 新欄 pdf_page 是 PDF 頁碼,跟 lecture_notes.page、lecture_bookmarks.page 一樣。
-- 這一步只加欄,不填值。

ALTER TABLE lecture_annotations ADD COLUMN pdf_page INTEGER;

CREATE INDEX idx_lecanno_user_slug_pdf_page
  ON lecture_annotations(user_email, slug, pdf_page);

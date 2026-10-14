-- 回填。舊的 page 是 0-based,對應的 PDF 頁碼是 page + 1。
-- 只填還沒寫的列:重跑這支不會把已經以 1-based 寫入的 pdf_page 再加一次。

UPDATE lecture_annotations
   SET pdf_page = page + 1
 WHERE pdf_page IS NULL;

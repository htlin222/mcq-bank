-- 舊欄退場。讀取與寫入都改走 pdf_page 之後才套用這支。
-- SQLite 不准 drop 還被索引用到的欄,所以先拆舊索引。
-- payload_json 裡的 pageIndex 仍是 0-based:那是 importAnnotations 的格式,
-- 改了它,舊螢光會畫到隔壁頁。那個值不在這張表的欄位裡。

DROP INDEX idx_lecanno_user_slug_page;

ALTER TABLE lecture_annotations DROP COLUMN page;

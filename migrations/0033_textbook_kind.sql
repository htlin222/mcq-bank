-- ============================================================
-- Migration 0033: 教科書引用 — lecture_docs.kind
--
-- 「選字問 Wintrobe」把一份英文血液學教科書(Wintrobe 15e)按章節拆冊,
-- 每冊當一列 lecture_docs(kind='textbook'),逐頁文字沿用既有
-- lecture_pages / lecture_pages_fts(migration 0016)。
--
-- 為何不新增段落級 FTS 表(設計 §2 原本主張):這份 calibre 轉檔 PDF
-- 每頁僅 ~300 字(9308 小頁),逐頁本身已達段落粒度,直接複用
-- lecture_pages_fts 即可,零額外表 / 觸發器。詳見
-- docs/plans/2026-07-23-textbook-citations-design.md。
--
--   kind ∈ {'lecture','textbook'}
--     'lecture'  — 複習班講義(出現在 /lectures grid;既有列預設值)
--     'textbook' — 唯讀參考書章節(不出現在 grid;由全站選字 popup 經
--                  /api/textbook/lookup 進入,以 /lectures/:slug?page=N 閱讀)
--
-- page_label_offset(選配,NULL = 不用):PDF 內頁 index → 書本印刷頁碼
--   的位移,供日後在 UI 顯示「p.1423」。v1 不使用。
-- ============================================================

ALTER TABLE lecture_docs ADD COLUMN kind TEXT NOT NULL DEFAULT 'lecture';
ALTER TABLE lecture_docs ADD COLUMN page_label_offset INTEGER;

-- 講義索引 / textbook lookup 皆以 kind 過濾;帶 sort_order 供列表排序。
CREATE INDEX IF NOT EXISTS idx_lecture_docs_kind ON lecture_docs(kind, sort_order);

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { annotationPdfPage } from "./annotation-page.ts";

test("新畫記只收 1-based 的 PDF 頁碼", () => {
	assert.equal(annotationPdfPage(1), 1);
	assert.equal(annotationPdfPage(16), 16);
	// 0 是舊的 viewer index。當成第 0 頁存進去,清單與跳頁會各說各話。
	assert.equal(annotationPdfPage(0), null);
	assert.equal(annotationPdfPage(-1), null);
	assert.equal(annotationPdfPage(1.5), null);
	assert.equal(annotationPdfPage("2"), null);
	assert.equal(annotationPdfPage(null), null);
});

test("回填是 page + 1,舊欄在讀取改完之後才 drop", () => {
	const backfill = readFileSync(
		"migrations/0075_lecture_annotation_pdf_page_backfill.sql",
		"utf8",
	);
	const contract = readFileSync(
		"migrations/0076_lecture_annotation_drop_zero_page.sql",
		"utf8",
	);
	assert.match(backfill, /SET pdf_page = page \+ 1/);
	assert.match(backfill, /pdf_page IS NULL/);
	assert.match(contract, /DROP INDEX idx_lecanno_user_slug_page/);
	assert.match(contract, /DROP COLUMN page/);
});

test("畫記的讀寫走 pdf_page,不再把 0-based 的 page 寫回去", () => {
	const src = readFileSync("worker/routes/lectures.ts", "utf8");
	assert.match(src, /pdf_page AS page/);
	assert.match(src, /ORDER BY pdf_page, created_at/);
	const start = src.indexOf("INSERT INTO lecture_annotations");
	const insert = src.slice(start, src.indexOf("VALUES", start));
	assert.match(insert, /pdf_page/);
	assert.doesNotMatch(insert, /\bpage,/);
	const backup = readFileSync("worker/routes/backup.ts", "utf8");
	assert.match(backup, /a\.pdf_page AS page/);
});

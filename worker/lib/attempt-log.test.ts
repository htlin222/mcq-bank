import { test } from "node:test";
import assert from "node:assert/strict";
import {
	parseAttemptFilters,
	buildAttemptWhere,
	renderAttemptCsv,
	taipeiDayStart,
	formatTaipei,
	exportFilename,
	flattenStem,
	type AttemptLogRow,
} from "./attempt-log.ts";

const ROW: AttemptLogRow = {
	created_at: Date.UTC(2026, 7, 7, 4, 30) /* 台北 12:30 */,
	year: 114,
	question_id: "114-001",
	stem: "一位 65 歲男性…",
	chosen: "B",
	chosen_text: "Imatinib",
	answer: "D",
	answer_text: "Dasatinib",
	is_correct: 0,
	confidence: 3,
	elapsed_ms: 42_500,
	tags: "CML|TKI",
	source: "review",
};

test("taipeiDayStart 換算成台北日界", () => {
	// 台北 2026-08-07 00:00 = UTC 2026-08-06 16:00
	assert.equal(taipeiDayStart("2026-08-07"), Date.UTC(2026, 7, 6, 16, 0));
});

test("taipeiDayStart 擋掉不存在的日期與壞格式", () => {
	assert.equal(taipeiDayStart("2026-02-31"), null); // Date.UTC 會捲成 3/3
	assert.equal(taipeiDayStart("2026-8-7"), null);
	assert.equal(taipeiDayStart(""), null);
	assert.equal(taipeiDayStart(20260807), null);
	assert.equal(taipeiDayStart(null), null);
});

test("formatTaipei 是台北時間不是 UTC", () => {
	assert.equal(formatTaipei(Date.UTC(2026, 7, 7, 4, 30)), "2026-08-07 12:30");
	// 跨日:UTC 前一天的 16:30 已經是台北的隔天 00:30
	assert.equal(formatTaipei(Date.UTC(2026, 7, 6, 16, 30)), "2026-08-07 00:30");
});

test("預設值 = 全部(沒有任何條件)", () => {
	const f = parseAttemptFilters({});
	assert.deepEqual(f, { years: [], wrongOnly: false, from: null, to: null });
});

test("年份去重、排序、濾掉非整數", () => {
	const f = parseAttemptFilters({ years: [114, 110, 114, "112", "x", 1.5, null] });
	assert.deepEqual(f.years, [110, 112, 114]);
});

test("「到某日」含當天整天(上界是隔日 00:00)", () => {
	const f = parseAttemptFilters({ from: "2026-08-01", to: "2026-08-07" });
	assert.equal(f.from, taipeiDayStart("2026-08-01"));
	assert.equal(f.to, taipeiDayStart("2026-08-08"));
});

test("wrong_only 只認 true,不認 'true' / 1", () => {
	assert.equal(parseAttemptFilters({ wrong_only: true }).wrongOnly, true);
	assert.equal(parseAttemptFilters({ wrong_only: "true" }).wrongOnly, false);
	assert.equal(parseAttemptFilters({ wrong_only: 1 }).wrongOnly, false);
});

test("WHERE 永遠鎖住 user_email,且只取有作答又已判定的列", () => {
	const { sql, params } = buildAttemptWhere("a@b.c", parseAttemptFilters({}));
	assert.match(sql, /a\.user_email = \?/);
	assert.match(sql, /a\.chosen IS NOT NULL/);
	assert.match(sql, /a\.is_correct IS NOT NULL/);
	assert.deepEqual(params, ["a@b.c"]);
});

test("WHERE 的佔位符數量與參數對齊", () => {
	const f = parseAttemptFilters({
		years: [114, 113],
		wrong_only: true,
		from: "2026-08-01",
		to: "2026-08-07",
	});
	const { sql, params } = buildAttemptWhere("a@b.c", f);
	assert.equal((sql.match(/\?/g) ?? []).length, params.length);
	assert.deepEqual(params, ["a@b.c", 113, 114, f.from, f.to]);
	assert.match(sql, /a\.is_correct = 0/);
});

test("CSV 有 BOM、標題列、以及一列資料", () => {
	const csv = renderAttemptCsv([ROW]);
	assert.ok(csv.startsWith("﻿"), "缺 BOM 的話 Excel 會開成亂碼");
	const lines = csv.split("\r\n");
	assert.equal(lines[0].replace("﻿", ""), "作答時間,年份,題號,題幹,我的答案,我的答案內容,正解,正解內容,是否答對,信心,秒數,標籤,來源");
	assert.equal(
		lines[1],
		"2026-08-07 12:30,114,114-001,一位 65 歲男性…,B,Imatinib,D,Dasatinib,錯誤,3,42.5,CML|TKI,複習",
	);
});

test("沒信心 / 沒計時的欄位留白,不填 0", () => {
	const csv = renderAttemptCsv([{ ...ROW, confidence: null, elapsed_ms: null, is_correct: 1 }]);
	const cells = csv.split("\r\n")[1].split(",");
	assert.equal(cells[8], "正確");
	assert.equal(cells[9], ""); // 信心
	assert.equal(cells[10], ""); // 秒數
});

test("題幹裡的逗號與換行不會撐破欄位", () => {
	const csv = renderAttemptCsv([{ ...ROW, stem: "A, B\n和 C" }]);
	assert.match(csv, /"A, B 和 C"/);
	// 只有標題列 + 一列資料 + 結尾空字串
	assert.equal(csv.trimEnd().split("\r\n").length, 2);
});

test("以 = 開頭的內容會被中和,避免試算表把它當公式", () => {
	const csv = renderAttemptCsv([{ ...ROW, chosen_text: "=1+1" }]);
	assert.match(csv, /"'=1\+1"/);
});

test("flattenStem 壓成單行", () => {
	assert.equal(flattenStem("  a\n\n b \t c "), "a b c");
});

test("檔名反映條件", () => {
	const now = Date.UTC(2026, 7, 7, 4, 0);
	assert.equal(exportFilename(parseAttemptFilters({}), now), "作答紀錄_2026-08-07.csv");
	assert.equal(
		exportFilename(parseAttemptFilters({ years: [114, 113], wrong_only: true }), now),
		"作答紀錄_113+114_錯題_2026-08-07.csv",
	);
});

// 答題狀態分析 —— 把 attempts(逐次作答的唯一真相)攤平成一張可下載的長表。
//
// 這裡只放純函式:過濾條件解析、WHERE 片段組裝、CSV 序列化、時間格式化。
// 碰 D1 的部分留在 routes/attempt-log.ts,測試才不用假造 D1。
//
// 為什麼讀 attempts 而不是 review_progress:後者是聚合快取(見 CLAUDE.md
// 「作答歷史」),答不出「這次選了什麼、花幾秒」。也因此 0023 之前的舊資料
// 在這張表裡不存在 —— 那是刻意的,展開聚合值成假時間戳會汙染唯一真相。

import { csvCell } from "./export-csv.ts";

/** 台北固定 UTC+8,沒有日光節約 —— 所以偏移可以寫死,不需要 Intl。 */
const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** 一次匯出的列數上限。20 人 × 1000 題的規模下,單人不該接近這個數;
 *  它存在是為了讓「Worker 記憶體」與「瀏覽器開得起來的 CSV」都有天花板。 */
export const MAX_EXPORT_ROWS = 20000;

/** 年份條件最多接受幾個值 —— 防止有人塞一萬個年份把 D1 的參數上限撐爆。 */
const MAX_YEARS = 50;

export type AttemptFilters = {
	/** 空陣列 = 不限年份(預設)。 */
	years: number[];
	/** true = 只要答錯的。 */
	wrongOnly: boolean;
	/** epoch ms,含。null = 不限。 */
	from: number | null;
	/** epoch ms,**不含**。呼叫端已把「到某日」換算成隔日 00:00。 */
	to: number | null;
};

/**
 * 'YYYY-MM-DD' → 該日台北時間 00:00 的 epoch ms。
 * 格式不合、或日期不存在(2026-02-31)一律回 null,當作「沒給這個條件」。
 */
export function taipeiDayStart(raw: unknown): number | null {
	if (typeof raw !== "string") return null;
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim());
	if (!m) return null;
	const y = Number(m[1]);
	const mo = Number(m[2]);
	const d = Number(m[3]);
	const utc = Date.UTC(y, mo - 1, d);
	// Date.UTC 會把 2026-02-31 悄悄捲成 3/3。回頭比對三個欄位才擋得掉。
	const back = new Date(utc);
	if (
		back.getUTCFullYear() !== y ||
		back.getUTCMonth() !== mo - 1 ||
		back.getUTCDate() !== d
	) {
		return null;
	}
	return utc - TAIPEI_OFFSET_MS;
}

/** epoch ms → 台北時間的 'YYYY-MM-DD HH:MM'。 */
export function formatTaipei(ms: number): string {
	const d = new Date(ms + TAIPEI_OFFSET_MS);
	const p = (n: number) => String(n).padStart(2, "0");
	return (
		`${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
		`${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`
	);
}

/** 不信任 client:年份去重、排序、上限,日期字串轉台北日界。 */
export function parseAttemptFilters(raw: unknown): AttemptFilters {
	const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
	const years = Array.isArray(o.years)
		? [
				...new Set(
					o.years
						.map((v) => Number(v))
						.filter((n) => Number.isInteger(n) && n >= 1 && n <= 9999),
				),
			]
				.sort((a, b) => a - b)
				.slice(0, MAX_YEARS)
		: [];
	const toStart = taipeiDayStart(o.to);
	return {
		years,
		wrongOnly: o.wrong_only === true,
		from: taipeiDayStart(o.from),
		// 「到 8/7」是含 8/7 一整天,所以上界取 8/8 00:00 再用嚴格小於。
		to: toStart === null ? null : toStart + DAY_MS,
	};
}

/**
 * 組出 attempts JOIN questions 的 WHERE 片段。
 *
 * 兩個永遠成立的條件:
 * - `a.chosen IS NOT NULL` —— 使用者說的「針對有作答的問題」。交卷時補的空題
 *   會寫一列 chosen = NULL,那不是一次作答。
 * - `a.is_correct IS NOT NULL` —— 模擬考交卷前尚未判定。留著會讓「是否答對」
 *   欄出現空白,任何 pivot / 正確率統計都會被那幾列拖歪。
 */
export function buildAttemptWhere(
	email: string,
	f: AttemptFilters,
): { sql: string; params: unknown[] } {
	const where = ["a.user_email = ?", "a.chosen IS NOT NULL", "a.is_correct IS NOT NULL"];
	const params: unknown[] = [email];
	if (f.years.length > 0) {
		where.push(`q.year IN (${f.years.map(() => "?").join(", ")})`);
		params.push(...f.years);
	}
	if (f.wrongOnly) where.push("a.is_correct = 0");
	if (f.from !== null) {
		where.push("a.created_at >= ?");
		params.push(f.from);
	}
	if (f.to !== null) {
		where.push("a.created_at < ?");
		params.push(f.to);
	}
	return { sql: where.join(" AND "), params };
}

export type AttemptLogRow = {
	created_at: number;
	year: number;
	question_id: string;
	stem: string;
	chosen: string;
	chosen_text: string;
	answer: string;
	answer_text: string;
	is_correct: number;
	confidence: number | null;
	elapsed_ms: number | null;
	tags: string;
	source: string;
};

export const ATTEMPT_CSV_COLUMNS = [
	"作答時間",
	"年份",
	"題號",
	"題幹",
	"我的答案",
	"我的答案內容",
	"正解",
	"正解內容",
	"是否答對",
	"信心",
	"秒數",
	"標籤",
	"來源",
] as const;

const SOURCE_LABEL: Record<string, string> = {
	review: "複習",
	exam: "模擬考",
	drill: "隨機練習",
	anki: "Anki 排程",
};

/** 題幹在 CSV 裡壓成單行 —— 換行會讓 Excel 的列數對不上肉眼看到的列數。 */
export function flattenStem(s: string): string {
	return s.replace(/\s+/g, " ").trim();
}

export function renderAttemptCsv(rows: AttemptLogRow[]): string {
	const lines = [ATTEMPT_CSV_COLUMNS.map((h) => csvCell(h)).join(",")];
	for (const r of rows) {
		lines.push(
			[
				formatTaipei(r.created_at),
				String(r.year),
				r.question_id,
				flattenStem(r.stem),
				r.chosen,
				flattenStem(r.chosen_text),
				r.answer,
				flattenStem(r.answer_text),
				r.is_correct ? "正確" : "錯誤",
				// 1=猜 2=普通 3=有把握。刻意輸出數字而非文字:這欄是拿來做樞紐分析
				// 與相關係數的,中文標籤在試算表裡排序會是筆劃順而不是強度順。
				r.confidence === null ? "" : String(r.confidence),
				r.elapsed_ms === null ? "" : (r.elapsed_ms / 1000).toFixed(1),
				r.tags,
				SOURCE_LABEL[r.source] ?? r.source,
			]
				.map((v) => csvCell(v))
				.join(","),
		);
	}
	// BOM:沒有它,Excel 會用系統字碼頁開這個檔,中文全變亂碼。
	return `﻿${lines.join("\r\n")}\r\n`;
}

/** 檔名帶上條件,下載好幾份時才分得出誰是誰。 */
export function exportFilename(f: AttemptFilters, now: number): string {
	const parts = ["作答紀錄"];
	if (f.years.length > 0) parts.push(f.years.join("+"));
	if (f.wrongOnly) parts.push("錯題");
	parts.push(formatTaipei(now).slice(0, 10));
	return `${parts.join("_")}.csv`;
}

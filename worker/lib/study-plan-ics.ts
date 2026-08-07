// 讀書計畫 → iCalendar (.ics)。純函式,不碰 D1、不碰 Date.now()。
//
// 為什麼是定時事件而不是全天事件:手機只有定時事件才會跳提醒。一份不會提醒
// 的計畫表不會被執行 —— 那正是這個功能想解決的問題。唯一的例外是考試當天,
// 我們不知道使用者幾點入場,硬編一個時間比不編更糟。
//
// UID 對「同一人 + 同一天」穩定,所以重複匯入是**更新**而非長出第二份行事曆。
// email 不以明文進 UID:.ics 常被匯進共用/同步的行事曆帳號。

import type { PlanResult } from "./study-plan.ts";

export type IcsOpts = {
	email: string;
	/** epoch ms,產生時間,寫進 DTSTAMP。 */
	now: number;
	/** 部署的公開 host,只用來組 UID 的網域部分。 */
	host: string;
	title?: string;
};

/** RFC 5545 TEXT 逸出。反斜線必須先處理,否則會把後面補上的逸出再逸出一次。 */
function esc(v: string): string {
	return v
		.replace(/\\/g, "\\\\")
		.replace(/;/g, "\\;")
		.replace(/,/g, "\\,")
		.replace(/\r?\n/g, "\\n");
}

/** 折行到 75 octet。續行以單一空格開頭,且該空格算進 75 之內。
 *  以 code point 逐字累加,所以不會把多位元組字元切成兩半。 */
export function foldIcsLine(line: string): string {
	const enc = new TextEncoder();
	const out: string[] = [];
	let cur = "";
	let bytes = 0;
	for (const ch of line) {
		const w = enc.encode(ch).length;
		if (bytes + w > 75) {
			out.push(cur);
			cur = " ";
			bytes = 1;
		}
		cur += ch;
		bytes += w;
	}
	out.push(cur);
	return out.join("\r\n");
}

/** 32-bit FNV-1a。不是密碼學雜湊,目的只是讓 UID 不含明文 email 且穩定。 */
function hash(s: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h.toString(16).padStart(8, "0");
}

export function planUid(email: string, date: string, host: string): string {
	return `plan-${hash(email)}-${date}@${host}`;
}

function stamp(ms: number): string {
	return `${new Date(ms).toISOString().replace(/[-:]/g, "").slice(0, 15)}Z`;
}

/** 'YYYY-MM-DD' → 'YYYYMMDD'。 */
function compact(day: string): string {
	return day.replace(/-/g, "");
}

/** 'HH:MM' → 分鐘數;格式不合退回 fallback。 */
function toMinutes(hhmm: string, fallback: number): number {
	const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm ?? ""));
	if (!m) return fallback;
	const h = Number(m[1]);
	const min = Number(m[2]);
	if (h > 23 || min > 59) return fallback;
	return h * 60 + min;
}

function localTime(day: string, minutes: number): string {
	const m = ((minutes % 1440) + 1440) % 1440;
	const hh = String(Math.floor(m / 60)).padStart(2, "0");
	const mm = String(m % 60).padStart(2, "0");
	return `${compact(day)}T${hh}${mm}00`;
}

function addDay(day: string): string {
	return new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000)
		.toISOString()
		.slice(0, 10);
}

const VTIMEZONE = [
	"BEGIN:VTIMEZONE",
	"TZID:Asia/Taipei",
	"X-LIC-LOCATION:Asia/Taipei",
	"BEGIN:STANDARD",
	// 台灣自 1980 年起不再實施日光節約,故單一 STANDARD 就夠。
	"DTSTART:19700101T000000",
	"TZOFFSETFROM:+0800",
	"TZOFFSETTO:+0800",
	"TZNAME:CST",
	"END:STANDARD",
	"END:VTIMEZONE",
];

export function renderPlanIcs(plan: PlanResult, opts: IcsOpts): string {
	const dtstamp = stamp(opts.now);
	const start = toMinutes(plan.study_start, 21 * 60);
	// 結束時間不晚於開始時間時,退回「開始 + 60 分鐘」而不是產生負長度事件。
	const rawEnd = toMinutes(plan.study_end, 22 * 60 + 30);
	const end = rawEnd > start ? rawEnd : start + 60;
	const mockEnd = start + 180; // 100 題的全真模擬撐不進晚間 90 分鐘

	const lines: string[] = [
		"BEGIN:VCALENDAR",
		"VERSION:2.0",
		"PRODID:-//hema-2026//study-plan//ZH-TW",
		"CALSCALE:GREGORIAN",
		"METHOD:PUBLISH",
		`X-WR-CALNAME:${esc(opts.title ?? "血液腫瘤讀書計畫")}`,
		"X-WR-TIMEZONE:Asia/Taipei",
		...VTIMEZONE,
	];

	const push = (
		date: string,
		summary: string,
		description: string,
		timing: string[],
	) => {
		lines.push(
			"BEGIN:VEVENT",
			`UID:${planUid(opts.email, date, opts.host)}`,
			`DTSTAMP:${dtstamp}`,
			...timing,
			`SUMMARY:${esc(summary)}`,
			`DESCRIPTION:${esc(description)}`,
			"END:VEVENT",
		);
	};

	for (const week of plan.weeks) {
		for (const day of week.days) {
			if (day.kind === "rest") continue;

			if (day.kind === "exam") {
				push(day.date, "血液腫瘤次專科考試", "計畫的終點。", [
					`DTSTART;VALUE=DATE:${compact(day.date)}`,
					`DTEND;VALUE=DATE:${compact(addDay(day.date))}`,
				]);
				continue;
			}

			if (day.kind === "mock") {
				push(day.date, "全真模擬 · 100 題", "一次做完 100 題,中途不查答案。", [
					`DTSTART;TZID=Asia/Taipei:${localTime(day.date, start)}`,
					`DTEND;TZID=Asia/Taipei:${localTime(day.date, mockEnd)}`,
				]);
				continue;
			}

			// 空手的一天不占行事曆版面。
			if (day.count === 0) continue;

			const rounds = [...new Set(day.slices.map((s) => s.round))];
			push(
				day.date,
				`${day.label} · ${day.count} 題`,
				`第 ${rounds.join("、")} 輪 · 共 ${day.count} 題`,
				[
					`DTSTART;TZID=Asia/Taipei:${localTime(day.date, start)}`,
					`DTEND;TZID=Asia/Taipei:${localTime(day.date, end)}`,
				],
			);
		}
	}

	lines.push("END:VCALENDAR");
	return `${lines.map(foldIcsLine).join("\r\n")}\r\n`;
}

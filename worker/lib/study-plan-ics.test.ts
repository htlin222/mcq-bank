import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPlan, type PlanContext, type PlanInput } from "./study-plan.ts";
import { renderPlanIcs, foldIcsLine, planUid } from "./study-plan-ics.ts";

const CTX: PlanContext = {
	today: "2026-08-07",
	examDate: "2026-09-05",
	years: [{ year: 114, total: 100, completed: 0, accuracy: 0.65 }],
};

const INPUT: PlanInput = {
	years: [114],
	completedOverride: null,
	minutesPerDay: 90,
	secondsPerQuestion: 90,
	rounds: 1,
	mockExams: 2,
	restSunday: true,
	studyStart: "21:00",
	studyEnd: "22:30",
};

const NOW = Date.parse("2026-08-07T02:00:00Z"); // = 10:00 UTC+8

function render(input: PlanInput = INPUT, ctx: PlanContext = CTX): string {
	return renderPlanIcs(buildPlan(input, ctx), {
		email: "a@example.com",
		now: NOW,
		host: "qa.example.com",
	});
}

function events(ics: string): string[][] {
	return ics
		.split("BEGIN:VEVENT")
		.slice(1)
		.map((b) => b.split("END:VEVENT")[0].trim().split("\r\n"));
}

test("是一份合法的 VCALENDAR,CRLF 換行且帶時區定義", () => {
	const ics = render();
	assert.equal(ics.startsWith("BEGIN:VCALENDAR\r\n"), true);
	assert.equal(ics.trimEnd().endsWith("END:VCALENDAR"), true);
	assert.match(ics, /^VERSION:2\.0\r$/m);
	assert.match(ics, /^BEGIN:VTIMEZONE\r$/m);
	assert.match(ics, /^TZID:Asia\/Taipei\r$/m);
	// 沒有裸 LF —— 裸 LF 會讓部分行事曆整份拒收。
	assert.equal(/[^\r]\n/.test(ics), false);
});

test("每個讀書日一個定時事件,時間取問卷的時段", () => {
	const ics = render();
	const evs = events(ics);
	const study = evs.filter((e) => e.some((l) => l.includes("DTSTART;TZID")));
	assert.equal(study.length > 0, true);

	const first = study[0].join("\n");
	assert.match(first, /DTSTART;TZID=Asia\/Taipei:20260808T210000/);
	assert.match(first, /DTEND;TZID=Asia\/Taipei:20260808T223000/);
	// SUMMARY 要寫得出「今天到底要做什麼」,不是空泛的「讀書」。
	assert.match(first, /SUMMARY:.*114 年第 \d+–\d+ 題/);
});

test("休息日不產生事件", () => {
	const ics = render();
	// 2026-08-09 / 16 / 23 / 30 是週日,restSunday = true。
	assert.equal(ics.includes("20260809T"), false);
	assert.equal(ics.includes("20260816T"), false);
});

test("模擬考日與考試日各一個獨立事件", () => {
	const ics = render();
	assert.match(ics, /SUMMARY:全真模擬/);
	// 模擬考 = examDate - 7k → 2026-08-29 / 2026-08-22。
	assert.match(ics, /DTSTART;TZID=Asia\/Taipei:20260829T/);
	// 考試日用全天事件 —— 我們不知道使用者幾點入場。
	assert.match(ics, /DTSTART;VALUE=DATE:20260905/);
	assert.match(ics, /DTEND;VALUE=DATE:20260906/);
	assert.match(ics, /SUMMARY:.*考試/);
});

test("跨午夜的事件把日期進位,不會產出負長度", () => {
	// 21:00 起的全真模擬要 3 小時 → 結束在隔天 00:00,不是同一天的 00:00。
	const ics = render();
	const evs = events(ics);
	for (const e of evs) {
		const s = e.find((l) => l.startsWith("DTSTART;TZID"))?.split(":")[1];
		const t = e.find((l) => l.startsWith("DTEND;TZID"))?.split(":")[1];
		if (!s || !t) continue;
		assert.equal(t > s, true, `事件結束時間不晚於開始:${s} → ${t}`);
	}

	// 晚讀書的人:23:30–01:00 也要跨到隔天。
	const late = render({ ...INPUT, studyStart: "23:30", studyEnd: "01:00" });
	assert.match(late, /DTSTART;TZID=Asia\/Taipei:20260810T233000/);
	assert.match(late, /DTEND;TZID=Asia\/Taipei:20260811T010000/);
});

test("UID 對同一人同一天穩定 —— 重匯入是更新而非長出第二份", () => {
	const a = planUid("a@example.com", "2026-08-08", "qa.example.com");
	const b = planUid("a@example.com", "2026-08-08", "qa.example.com");
	assert.equal(a, b);
	assert.notEqual(a, planUid("a@example.com", "2026-08-09", "qa.example.com"));
	assert.notEqual(a, planUid("b@example.com", "2026-08-08", "qa.example.com"));
	// email 不以明文進 UID —— .ics 會被匯進共用行事曆。
	assert.equal(a.includes("a@example.com"), false);
	assert.match(a, /@qa\.example\.com$/);

	const ids = render()
		.split("\r\n")
		.filter((l) => l.startsWith("UID:"));
	assert.equal(new Set(ids).size, ids.length);
});

test("特殊字元照 RFC 5545 逸出,不會撐破欄位", () => {
	const ics = renderPlanIcs(
		buildPlan(INPUT, {
			...CTX,
			years: [{ year: 114, total: 100, completed: 0, accuracy: 0.65 }],
		}),
		{
			email: "a@example.com",
			now: NOW,
			host: "qa.example.com",
			title: "讀書計畫; 第一版\n換行,逗號\\反斜線",
		},
	);
	assert.match(ics, /X-WR-CALNAME:.*\\;.*\\n.*\\,.*\\\\/);
	assert.equal(/[^\r]\n/.test(ics), false);
});

test("超過 75 octet 的行要折行,續行以單一空格開頭", () => {
	const long = `SUMMARY:${"題".repeat(60)}`;
	const folded = foldIcsLine(long);
	const lines = folded.split("\r\n");
	assert.equal(lines.length > 1, true);
	for (const l of lines) {
		assert.equal(new TextEncoder().encode(l).length <= 75, true);
	}
	assert.equal(
		lines.slice(1).every((l) => l.startsWith(" ")),
		true,
	);
	// 折行不可切斷多位元組字元。
	const rejoined = lines.map((l, i) => (i === 0 ? l : l.slice(1))).join("");
	assert.equal(rejoined, long);
});

test("一題都沒排時仍是合法日曆(只有考試日)", () => {
	// 模擬考也關掉 —— 它與年份選擇無關,開著就理當出現在日曆上。
	const ics = render({ ...INPUT, years: [], mockExams: 0 });
	assert.match(ics, /BEGIN:VCALENDAR/);
	assert.match(ics, /DTSTART;VALUE=DATE:20260905/);
	assert.equal(ics.includes("DTSTART;TZID"), false);
});

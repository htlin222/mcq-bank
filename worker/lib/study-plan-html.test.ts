import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPlan, type PlanContext, type PlanInput } from "./study-plan.ts";
import { renderPlanHtml } from "./study-plan-html.ts";

const CTX: PlanContext = {
	today: "2026-08-07",
	examDate: "2026-09-05",
	years: [
		{ year: 114, total: 100, completed: 0, accuracy: 0.65 },
		{ year: 113, total: 100, completed: 0, accuracy: 0.5 },
	],
};

const INPUT: PlanInput = {
	years: [114, 113],
	completedOverride: null,
	minutesPerDay: 90,
	secondsPerQuestion: 90,
	rounds: 2,
	mockExams: 2,
	restSunday: true,
	studyStart: "21:00",
	studyEnd: "22:30",
};

const META = { email: "a@example.com", now: Date.parse("2026-08-07T02:00:00Z") };

test("是一份自足的 HTML —— 不引用任何外部資源", () => {
	const html = renderPlanHtml(buildPlan(INPUT, CTX), META);
	assert.match(html, /^<!doctype html>/i);
	assert.match(html, /<html lang="zh-Hant">/);
	// 外部字型 / CDN / 圖片一律不可 —— 這份檔案要能離線開、能寄給自己。
	assert.equal(/(src|href)="https?:\/\//.test(html), false);
	assert.equal(html.includes("<script"), false || html.includes("window.print"));
});

test("帶列印樣式,且列印時隱藏那顆列印按鈕", () => {
	const html = renderPlanHtml(buildPlan(INPUT, CTX), META);
	assert.match(html, /@media print/);
	assert.match(html, /window\.print\(\)/);
	assert.match(html, /@media print\s*\{[^}]*\.no-print[^}]*display:\s*none/s);
});

test("每一天都在表上,休息日與模擬考日也在", () => {
	const plan = buildPlan(INPUT, CTX);
	const html = renderPlanHtml(plan, META);
	for (const week of plan.weeks) {
		assert.equal(html.includes(week.week_start), true);
		for (const day of week.days) {
			assert.equal(html.includes(day.date), true);
		}
	}
	assert.match(html, /休息/);
	assert.match(html, /全真模擬/);
	assert.match(html, /考試日/);
});

test("排不完時,差額寫在最前面,不埋進表格裡", () => {
	const tight = buildPlan(
		{ ...INPUT, minutesPerDay: 15 },
		CTX,
	);
	assert.equal(tight.shortfall > 0, true);
	const html = renderPlanHtml(tight, META);

	assert.match(html, new RegExp(`差 ${tight.shortfall} 題`));
	// 出現在第一張週表之前 —— 版面上不能被行事曆推到看不見的地方。
	assert.equal(
		html.indexOf(`差 ${tight.shortfall} 題`) < html.indexOf("<table"),
		true,
	);
	// 三條建議都要有具體數字。
	assert.match(html, /每天多 \d+ 題/);
	assert.match(html, /不寫 \d+ 年/);
	assert.match(html, /改成 \d+ 輪/);
});

test("排得完時不出現差額區塊,也不出現空的建議清單", () => {
	const html = renderPlanHtml(buildPlan(INPUT, CTX), META);
	assert.equal(html.includes("差 "), false);
	assert.equal(html.includes("<ul class=\"advice\">"), false);
});

test("AI 導讀有就顯示,沒有整段消失", () => {
	const plan = buildPlan(INPUT, CTX);
	const withAi = renderPlanHtml(plan, {
		...META,
		coaching: "凝血是目前最弱的一塊。",
	});
	assert.match(withAi, /凝血是目前最弱的一塊。/);

	const without = renderPlanHtml(plan, META);
	assert.equal(without.includes("class=\"coaching\""), false);
	// 空白字串等同沒有,不留一個空框。
	assert.equal(
		renderPlanHtml(plan, { ...META, coaching: "   " }).includes(
			'class="coaching"',
		),
		false,
	);
});

test("使用者可控的字串一律逸出", () => {
	const html = renderPlanHtml(buildPlan(INPUT, CTX), {
		...META,
		email: "<script>alert(1)</script>@x.com",
		coaching: "<img src=x onerror=alert(1)>",
	});
	assert.equal(html.includes("<script>alert(1)</script>"), false);
	assert.equal(html.includes("<img src=x"), false);
	assert.match(html, /&lt;script&gt;/);
});

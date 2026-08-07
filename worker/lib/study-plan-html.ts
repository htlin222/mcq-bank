// 讀書計畫 → 單檔 HTML。自足、可離線開、可從瀏覽器列印成 PDF。
//
// Worker 端不產真 PDF(見 export-html.ts 同一個結論):Browser Rendering 要
// 付費,純 JS 的 pdf-lib 得嵌 CJK 字型而字型檔超過 bundle 上限。瀏覽器列印
// 的輸出跟真 PDF 沒有差別,成本是零。
//
// 版面沿用站上的 editorial 調性(ink / cream / 單一 accent、全 sans),色票直接
// 對應 frontend/tailwind.config.js,免得兩邊漂移。

import { escapeHtml } from "./tiptap-render.ts";
import type { PlanResult, Suggestion } from "./study-plan.ts";

export type PlanHtmlMeta = {
	email: string;
	/** epoch ms,產生時間。 */
	now: number;
	/** AI 弱點導讀;空白或未給則整段不出現。 */
	coaching?: string;
};

const STYLES = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
body {
  margin: 0; padding: 2.5rem 1.5rem 4rem;
  background: #f7f5f2; color: #2a2419;
  font-family: "Inter", "Noto Sans TC", system-ui, sans-serif;
  font-size: 15px; line-height: 1.7;
}
.sheet { max-width: 52rem; margin: 0 auto; }
h1 { font-size: 1.6rem; margin: 0 0 .25rem; letter-spacing: .01em; }
h2 { font-size: 1rem; margin: 2.25rem 0 .6rem; color: #5d5240;
     text-transform: uppercase; letter-spacing: .12em; font-weight: 600; }
.lede { color: #5d5240; margin: 0 0 1.5rem; font-size: .9rem; }
.facts { display: flex; flex-wrap: wrap; gap: 0 2rem; padding: 0; margin: 0 0 1.5rem;
         list-style: none; border-top: 1px solid #d8d0c2; border-bottom: 1px solid #d8d0c2; }
.facts li { padding: .7rem 0; font-size: .9rem; }
.facts b { display: block; font-size: 1.25rem; font-weight: 600; color: #a8442a;
           font-variant-numeric: tabular-nums; }
.facts span { color: #5d5240; font-size: .78rem; text-transform: uppercase; letter-spacing: .08em; }
.coaching { border-left: 3px solid #a8442a; padding: .1rem 0 .1rem 1rem; margin: 0 0 1.75rem;
            color: #3f3729; }
.gap { background: #fff; border: 1px solid #cb6845; border-radius: 6px;
       padding: 1rem 1.25rem; margin: 0 0 1.75rem; }
.gap p { margin: 0 0 .6rem; font-size: 1.02rem; }
.advice { margin: 0; padding-left: 1.2rem; color: #3f3729; font-size: .93rem; }
.advice li { margin: .2rem 0; }
table { width: 100%; border-collapse: collapse; margin: 0 0 1.5rem;
        background: #fff; font-size: .92rem; }
caption { text-align: left; font-weight: 600; padding: .5rem 0 .35rem; color: #5d5240; }
th, td { text-align: left; padding: .5rem .7rem; border-bottom: 1px solid #ede9e2;
         vertical-align: top; }
th { font-weight: 600; font-size: .78rem; color: #5d5240; text-transform: uppercase;
     letter-spacing: .07em; background: #f7f5f2; }
td.n { font-variant-numeric: tabular-nums; white-space: nowrap; width: 4.5rem; }
tr.rest td, tr.rest td.n { color: #8a7d65; }
tr.mock td, tr.exam td { background: #fdf6f2; font-weight: 600; }
footer { margin-top: 2.5rem; padding-top: 1rem; border-top: 1px solid #d8d0c2;
         color: #8a7d65; font-size: .8rem; }
button.no-print { font: inherit; cursor: pointer; background: #a8442a; color: #fff;
                  border: 0; border-radius: 6px; padding: .5rem 1rem; margin: 0 0 1.75rem; }
@media print {
  .no-print { display: none !important; }
  body { background: #fff; padding: 0; font-size: 11pt; }
  table { page-break-inside: avoid; }
  tr { page-break-inside: avoid; }
  h2 { page-break-after: avoid; }
}
`;

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

function weekdayOf(date: string): string {
	return WEEKDAYS[new Date(Date.parse(`${date}T00:00:00Z`)).getUTCDay()];
}

function formatNow(ms: number): string {
	return new Date(ms + 8 * 3_600_000).toISOString().slice(0, 16).replace("T", " ");
}

function adviceText(s: Suggestion): string {
	if (s.kind === "more_per_day")
		return `每天多 ${s.extra_questions} 題(約多花 ${s.extra_minutes} 分鐘)`;
	if (s.kind === "drop_year")
		return `不寫 ${s.year} 年(少 ${s.questions} 題)`;
	return `改成 ${s.rounds} 輪`;
}

function fact(value: string, label: string): string {
	return `<li><b>${escapeHtml(value)}</b><span>${escapeHtml(label)}</span></li>`;
}

function weekTable(week: PlanResult["weeks"][number]): string {
	const rows = week.days
		.map((d) => {
			const body =
				d.kind === "exam"
					? "考試日"
					: d.kind === "mock"
						? "全真模擬 · 100 題"
						: d.kind === "rest"
							? "休息"
							: d.label || "—";
			const n = d.count > 0 ? `${d.count} 題` : "—";
			return (
				`<tr class="${d.kind}">` +
				// 印完整日期而不是 MM-DD:這張表可能跨年,而且它會被印出來離開
				// 螢幕,沒有旁邊的月份標題可以推。
				`<td class="n">${escapeHtml(d.date)} (${weekdayOf(d.date)})</td>` +
				`<td>${escapeHtml(body)}</td>` +
				`<td class="n">${escapeHtml(n)}</td>` +
				`</tr>`
			);
		})
		.join("");

	return (
		`<table><caption>${escapeHtml(week.week_start)} 起 · 本週 ${week.total} 題</caption>` +
		`<thead><tr><th>日期</th><th>內容</th><th>題數</th></tr></thead>` +
		`<tbody>${rows}</tbody></table>`
	);
}

export function renderPlanHtml(plan: PlanResult, meta: PlanHtmlMeta): string {
	const coaching = (meta.coaching ?? "").trim();

	// 排不完的那句話放在所有表格之前。它是使用者現在就該做決定的唯一理由,
	// 被行事曆推到看不見的地方等於沒說。
	const gap =
		plan.shortfall > 0
			? `<section class="gap"><p>以這個速度,到考前<strong>差 ${plan.shortfall} 題</strong>。</p>` +
				(plan.suggestions.length > 0
					? `<ul class="advice">${plan.suggestions
							.map((s) => `<li>${escapeHtml(adviceText(s))}</li>`)
							.join("")}</ul>`
					: "") +
				`</section>`
			: "";

	const rounds = plan.demand_by_round
		.map((n, i) => `第 ${i + 1} 輪 ${n} 題`)
		.join(" · ");

	return `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>讀書計畫 · 至 ${escapeHtml(plan.exam_date)}</title>
<style>${STYLES}</style>
</head>
<body>
<div class="sheet">
<h1>血液腫瘤次專科 讀書計畫</h1>
<p class="lede">${escapeHtml(meta.email)} · 產生於 ${escapeHtml(formatNow(meta.now))} (UTC+8)</p>
<button type="button" class="no-print" id="print-btn">列印 / 存成 PDF</button>
<ul class="facts">
${fact(String(plan.days_left), "距考試天數")}
${fact(String(plan.daily_capacity), "每日題數上限")}
${fact(String(plan.available_days), "可讀日")}
${fact(String(plan.scheduled), "已排入題數")}
</ul>
${coaching ? `<p class="coaching">${escapeHtml(coaching)}</p>` : ""}
${gap}
<h2>需求</h2>
<p class="lede">${escapeHtml(rounds)}${plan.mock_dates.length > 0 ? ` · 全真模擬 ${plan.mock_dates.length} 場` : ""}</p>
<h2>逐週</h2>
${plan.weeks.map(weekTable).join("\n")}
<footer>計畫由「輸入參數 + 當下進度」即時算出;進度變了重新產生一次即可。此檔僅供本人使用。</footer>
</div>
<script>document.getElementById('print-btn').addEventListener('click',function(){window.print()})</script>
</body>
</html>
`;
}

import { test } from "node:test";
import assert from "node:assert/strict";
import { renderExportHtml } from "./export-html.ts";
import { EXPORT_STYLES } from "./export-styles.ts";
import type { ExportItem } from "./export-doc.ts";

const base: ExportItem = {
	id: "114-001",
	year: 114,
	number: 1,
	group: "內科",
	stem: "CML 的標記?",
	options: [{ key: "A", text: "BCR-ABL1" }],
	answer: "A",
	tags: ["CML"],
	explanation: null,
	note: null,
	highlights: [],
};

const meta = { label: "114 年", email: "me@x.test", now: Date.UTC(2026, 6, 20, 4, 5) };
const html = (items: ExportItem[], m = meta) => renderExportHtml(items, m);

test("單檔 HTML:doctype / meta / title / 內嵌 <style>", () => {
	const out = html([base]);
	assert.ok(out.startsWith("<!doctype html>"));
	assert.ok(out.includes('<meta charset="utf-8">'));
	assert.ok(out.includes('name="viewport"'));
	assert.ok(out.includes("<title>114 年</title>"));
	assert.ok(out.includes("<style>"));
	assert.ok(out.includes(EXPORT_STYLES));
});

test("匯出樣式是白底黑字、字級只有三階、而且沒有深色模式", () => {
	const out = html([base]);

	// 白底黑字。深色模式**刻意沒有** —— 一份會被列印與封存的文件不該跟著讀者的
	// 作業系統主題變色,而深色配色列印時背景會被丟掉、只留下淺色文字。
	assert.ok(/body\s*\{[^}]*background:\s*#fff/.test(out));
	assert.ok(!out.includes("prefers-color-scheme"));
	// 舊版那套 Catppuccin 變數整組不該再出現。
	assert.ok(!out.includes("--ctp-"));

	// 字級只有 12 / 15 / 19px 三階。舊版是 12–24px,題幹像標題、詳解像註腳,
	// 而它們其實都是要讀的正文。
	const sizes = new Set(
		[...out.matchAll(/font-size:\s*(\d+)px/g)].map((m) => m[1]),
	);
	assert.deepEqual([...sizes].sort(), ["12", "15", "19"]);

	// 正解與畫記**不靠顏色**:灰階列印下綠色和黑色一樣黑。
	assert.ok(/\.answer\s*\{[^}]*border-left:\s*3px solid/.test(out));
	assert.ok(/mark\s*\{[^}]*border-bottom:\s*2px solid/.test(out));
	assert.ok(/mark\s*\{[^}]*background:\s*none/.test(out));

	// 列印:有頁邊界、一題盡量不跨頁、底色不印。
	assert.ok(out.includes("@page"));
	assert.ok(out.includes("@media print"));
	assert.ok(/@media print\s*\{[\s\S]*break-inside: avoid/.test(out));

	// 拿掉顏色之後,詳解 / 個人筆記 / 畫記 只剩一模一樣的分隔線 —— 靠 ::before
	// 補回區塊標籤(語意換一個維度重講)。**做在樣式層,不是改標記** —— 標記與
	// mcq-to-anki 的 back.html 對齊,不該為了排版讓兩邊漂移。
	for (const label of ["詳解", "個人筆記", "畫記"]) {
		assert.ok(
			out.includes(`content: "${label}"`),
			`樣式表少了「${label}」的區塊標籤`,
		);
	}
	// 那三個標籤不該出現在標記裡(否則就是改了 backHtml)。
	assert.ok(!out.includes(">個人筆記<"));

	// .card / .card.nightMode 是 Anki 的 class,單檔裡不該有這兩條規則
	assert.ok(!/^\.card[\s.{]/m.test(out));
	assert.ok(!out.includes(".card.nightMode {"));
	// 每題不該佔滿整螢幕
	assert.ok(!out.includes("min-height: 100vh"));
});

test("markup 契約沒有跟著配色一起換掉", () => {
	// 配色不再與 mcq-to-anki 同步,但 class 名稱仍然對齊它的 templates/back.html
	// —— export-html.ts / export-csv.ts 產生的標記因此一行都不用改。
	const out = html([base]);
	for (const sel of [
		".anki-note",
		".field-front",
		".field-back",
		".qid",
		".stem",
		".options",
		".optkey",
		".answer",
		".expl",
	]) {
		assert.ok(out.includes(sel), `樣式表少了 ${sel}`);
	}
});

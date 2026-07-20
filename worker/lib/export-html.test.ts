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

test("樣式來自 mcq-to-anki,且已做單檔化處理", () => {
	const out = html([base]);
	// 亮色變數在 :root,深色那組在 prefers-color-scheme
	assert.ok(/:root\s*\{[^}]*--ctp-base: #eff1f5/.test(out));
	assert.ok(out.includes("@media (prefers-color-scheme: dark)"));
	assert.ok(out.includes("--ctp-base: #1e1e2e"));
	// .card / .card.nightMode 是 Anki 的 class,單檔裡不該有這兩條規則
	assert.ok(!/^\.card[\s.{]/m.test(out));
	assert.ok(!out.includes(".card.nightMode {"));
	// 每題不該佔滿整螢幕
	assert.ok(!out.includes("min-height: 100vh"));
});

test("結構照 back.html:main.anki-note > .field-front + .field-back", () => {
	const out = html([base]);
	assert.ok(out.includes('<main class="anki-note">'));
	assert.ok(out.includes('<section class="field field-front">'));
	assert.ok(out.includes('<section class="field field-back">'));
	assert.ok(out.includes('<div class="qid">114-001</div>'));
	assert.ok(out.includes('<span class="optkey">A.</span>'));
	assert.ok(out.includes('<div class="answer">正解:A. BCR-ABL1</div>'));
});

test("多題:重複 main,數量正確", () => {
	const out = html([base, { ...base, id: "114-002" }]);
	assert.equal((out.match(/<main class="anki-note">/g) || []).length, 2);
});

test("檔頭含範圍、時間、題數與隱私提示", () => {
	const out = html([base]);
	assert.ok(out.includes("<h1>114 年</h1>"));
	assert.ok(out.includes("本檔含 me@x.test 的私人筆記與畫記,僅供本人使用,請勿轉傳。"));
	assert.ok(out.includes("2026-07-20 12:05")); // UTC+8
	assert.ok(out.includes("題數:1"));
});

test("label / email 會被 HTML 跳脫", () => {
	const out = html([base], { ...meta, label: "<script>x</script>", email: "a<b@x.test" });
	assert.ok(!out.includes("<script>x</script>"));
	assert.ok(out.includes("&lt;script&gt;"));
	assert.ok(out.includes("a&lt;b@x.test"));
});

test("footnotes 出現在檔尾;沒有時不產生 footer", () => {
	assert.ok(!html([base]).includes("<footer"));
	const out = renderExportHtml([base], { ...meta, footnotes: ["3 張圖片未內嵌。"] });
	assert.ok(out.includes("<footer"));
	assert.ok(out.includes("3 張圖片未內嵌。"));
});

test("詳解 / 筆記 / 畫記各有自己的 wrapper class", () => {
	const p = (s: string) => ({
		type: "doc",
		content: [{ type: "paragraph", content: [{ type: "text", text: s }] }],
	});
	const out = html([{ ...base, explanation: p("e"), note: p("n"), highlights: ["h"] }]);
	assert.ok(out.includes('<div class="expl"><p>e</p></div>'));
	assert.ok(out.includes('<div class="note"><p>n</p></div>'));
	assert.ok(out.includes('<div class="hl"><ul><li><mark>h</mark></li></ul></div>'));
});

test("opts.imageSrc 會套用到匯出的 HTML(base64 內嵌路徑)", () => {
	const doc = { type: "doc", content: [{ type: "image", attrs: { src: "/img/a.png" } }] };
	const out = renderExportHtml([{ ...base, explanation: doc }], meta, {
		imageSrc: () => "data:image/png;base64,AAAA",
	});
	assert.ok(out.includes('src="data:image/png;base64,AAAA"'));
});

test("空 items → 仍是合法單檔,題數 0", () => {
	const out = html([]);
	assert.ok(out.includes("題數:0"));
	assert.ok(out.trimEnd().endsWith("</html>"));
});

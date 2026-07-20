import { test } from "node:test";
import assert from "node:assert/strict";
import { csvCell, renderExportCsv, ankiTags } from "./export-csv.ts";
import type { ExportItem } from "./export-doc.ts";

const base: ExportItem = {
	id: "114-001",
	year: 114,
	number: 1,
	group: "內科",
	stem: "CML 的標記?",
	options: [
		{ key: "A", text: "BCR-ABL1" },
		{ key: "B", text: "PML-RARA" },
	],
	answer: "A",
	tags: [],
	explanation: null,
	note: null,
	highlights: [],
};

const p = (s: string) => ({
	type: "doc",
	content: [{ type: "paragraph", content: [{ type: "text", text: s }] }],
});

const ORIGIN = "https://h.test";
const render = (items: ExportItem[]) => renderExportCsv(items, { origin: ORIGIN });
// 資料列讀出來時要先還原 CSV 的雙引號跳脫,才看得到原本的 HTML。
const dataRow = (items: ExportItem[], i = 0) =>
	render(items).split("\n")[6 + i].replace(/""/g, '"');

// -------------------------------------------------------------- csvCell

test("csvCell:含逗號 / 雙引號 / 換行 / 前後空白 → 加引號,內部 \" 加倍", () => {
	assert.equal(csvCell("plain"), "plain");
	assert.equal(csvCell("a,b"), '"a,b"');
	assert.equal(csvCell('a"b'), '"a""b"');
	assert.equal(csvCell("a\nb"), '"a\nb"');
	assert.equal(csvCell("a\r\nb"), '"a\r\nb"');
	assert.equal(csvCell(" lead"), '" lead"');
	assert.equal(csvCell("trail "), '"trail "');
	assert.equal(csvCell(""), "");
});

test("csvCell:以 = + - @ 開頭的值加前綴,避免試算表把它當公式", () => {
	for (const ch of ["=", "+", "-", "@"]) {
		const out = csvCell(`${ch}cmd(1)`);
		assert.ok(out.startsWith('"\''), `${ch} 沒有被中和: ${out}`);
	}
});

// ------------------------------------------------------------- 標頭指令

test("首行起輸出 Anki 匯入指令標頭", () => {
	const lines = render([base]).split("\n");
	assert.deepEqual(lines.slice(0, 6), [
		"#separator:Comma",
		"#html:true",
		"#notetype:血專",
		"#deck:血專::匯出",
		"#columns:Front,Back,Tags",
		"#tags column:3",
	]);
});

test("空 items → 只有標頭,沒有資料列", () => {
	assert.equal(render([]).trimEnd().split("\n").length, 6);
});

// ---------------------------------------------------------- Front / Back

test("Front 結構對齊 mcq-to-anki:.qid / .stem / ul.options + .optkey", () => {
	const row = dataRow([base]);
	assert.ok(row.includes('<div class="qid">114-001</div>'));
	assert.ok(row.includes('<div class="stem">CML 的標記?</div>'));
	assert.ok(row.includes('<ul class="options">'));
	assert.ok(row.includes('<li><span class="optkey">A.</span>BCR-ABL1</li>'));
	assert.ok(row.includes('<li><span class="optkey">B.</span>PML-RARA</li>'));
});

test("Back 有 .answer;詳解 / 筆記 / 畫記各自的 wrapper 只在有內容時出現", () => {
	const plain = dataRow([base]);
	assert.ok(plain.includes('<div class="answer">正解:A. BCR-ABL1</div>'));
	assert.ok(!plain.includes('class="expl"'));
	assert.ok(!plain.includes('class="note"'));
	assert.ok(!plain.includes('class="hl"'));

	const full = dataRow([
		{ ...base, explanation: p("因為 t(9;22)"), note: p("記得考"), highlights: ["重點"] },
	]);
	assert.ok(full.includes('<div class="expl"><p>因為 t(9;22)</p></div>'));
	assert.ok(full.includes('<div class="note"><p>記得考</p></div>'));
	assert.ok(full.includes('<div class="hl"><ul><li><mark>重點</mark></li></ul></div>'));
});

test("HTML 特殊字元在題幹 / 選項中被跳脫", () => {
	const row = dataRow([{ ...base, stem: "a<b>&c", options: [{ key: "A", text: '"x"' }] }]);
	assert.ok(row.includes("a&lt;b&gt;&amp;c"));
	assert.ok(!row.includes("<b>"));
});

// ------------------------------------------------------------------ 圖片

test("圖片 src 一律改寫成絕對 URL,不出現相對路徑", () => {
	const doc = {
		type: "doc",
		content: [{ type: "image", attrs: { src: "/img/years/114/a.png" } }],
	};
	const row = dataRow([{ ...base, explanation: doc }]);
	assert.ok(row.includes('src="https://h.test/img/years/114/a.png"'));
	assert.ok(!/src="\/img\//.test(row));
	// 外部 http(s) 圖片維持原樣
	const ext = {
		type: "doc",
		content: [{ type: "image", attrs: { src: "https://other.test/b.png" } }],
	};
	assert.ok(render([{ ...base, explanation: ext }]).includes("https://other.test/b.png"));
});

// ------------------------------------------------------------------ Tags

test("ankiTags:question_tags + 年份-114,空白換底線,重複去除", () => {
	assert.deepEqual(ankiTags({ ...base, tags: ["CML", "TKI 治療"] }), [
		"CML",
		"TKI_治療",
		"年份-114",
	]);
	assert.deepEqual(ankiTags(base), ["年份-114"]);
	assert.deepEqual(ankiTags({ ...base, tags: ["年份-114"] }), ["年份-114"]);
});

test("Tags 欄以空白分隔,且是第 3 欄", () => {
	const row = render([{ ...base, tags: ["CML"] }]).split("\n")[6];
	// 三欄,前兩欄含逗號所以會被引號包住 → 用最後一段判斷
	assert.ok(row.endsWith(",CML 年份-114"));
});

test("每題一列(CSV 內的換行都在引號內)", () => {
	const out = render([base, { ...base, id: "114-002", number: 2 }]);
	assert.equal(out.trimEnd().split("\n").length, 8);
});

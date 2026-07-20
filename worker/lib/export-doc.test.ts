import { test } from "node:test";
import assert from "node:assert/strict";
import {
	renderQuestionMarkdown,
	renderExportMarkdown,
	contentDisposition,
	type ExportItem,
} from "./export-doc.ts";

const base: ExportItem = {
	id: "114-001",
	year: 114,
	number: 1,
	group: "內科",
	stem: "下列何者為 CML 的標記?",
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

test("標題為 ## 114-001,選項逐條列出,正解列出 key + 該選項文字", () => {
	const md = renderQuestionMarkdown(base);
	assert.ok(md.startsWith("## 114-001\n"));
	assert.ok(md.includes("下列何者為 CML 的標記?"));
	assert.ok(md.includes("- **A.** BCR-ABL1"));
	assert.ok(md.includes("- **B.** PML-RARA"));
	assert.ok(md.includes("**正解:A. BCR-ABL1**"));
});

test("正解 key 對不到任何選項時只印 key,不炸", () => {
	const md = renderQuestionMarkdown({ ...base, answer: "E" });
	assert.ok(md.includes("**正解:E**"));
});

test("詳解為 null 時整個「詳解」小節不出現", () => {
	assert.ok(!renderQuestionMarkdown(base).includes("### 詳解"));
	const md = renderQuestionMarkdown({ ...base, explanation: p("因為 t(9;22)") });
	assert.ok(md.includes("### 詳解\n\n因為 t(9;22)"));
});

test("詳解是空 doc 時也不出現(渲染後為空字串)", () => {
	const md = renderQuestionMarkdown({ ...base, explanation: { type: "doc", content: [] } });
	assert.ok(!md.includes("### 詳解"));
});

test("詳解 / 筆記內的標題被壓到 #### 以下,不會蓋過區塊標題", () => {
	const md = renderQuestionMarkdown({
		...base,
		explanation: {
			type: "doc",
			content: [{ type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "機轉" }] }],
		},
	});
	assert.ok(md.includes("### 詳解\n\n#### 機轉"));
});

test("筆記為 null 時「我的筆記」不出現", () => {
	assert.ok(!renderQuestionMarkdown(base).includes("### 我的筆記"));
	const md = renderQuestionMarkdown({ ...base, note: p("記得考") });
	assert.ok(md.includes("### 我的筆記\n\n記得考"));
});

test("畫記為空陣列時「我的畫記」不出現;有畫記時逐條列出", () => {
	assert.ok(!renderQuestionMarkdown(base).includes("### 我的畫記"));
	const md = renderQuestionMarkdown({ ...base, highlights: ["重點一", "重點二"] });
	assert.ok(md.includes("### 我的畫記\n\n- 重點一\n- 重點二"));
});

test("tags 空時不輸出 tag 行", () => {
	assert.ok(!renderQuestionMarkdown(base).includes("標籤"));
	assert.ok(renderQuestionMarkdown({ ...base, tags: ["CML", "TKI"] }).includes("標籤:`CML` `TKI`"));
});

test("stem 內的 markdown 特殊字元不破版(維持原文可讀)", () => {
	const md = renderQuestionMarkdown({ ...base, stem: "a\nb" });
	assert.ok(md.includes("a\nb"));
});

test("renderExportMarkdown 產出檔頭 + 隱私提示 + 題數,題間以 --- 分隔", () => {
	const out = renderExportMarkdown([base, { ...base, id: "114-002", number: 2 }], {
		label: "收藏・心臟",
		email: "me@x.test",
		now: Date.UTC(2026, 6, 20, 4, 5, 0),
	});
	assert.ok(out.startsWith("# 收藏・心臟"));
	assert.ok(out.includes("> 本檔含 me@x.test 的私人筆記與畫記,僅供本人使用,請勿轉傳。"));
	assert.ok(out.includes("2026-07-20 12:05")); // UTC+8
	assert.ok(out.includes("題數:2"));
	assert.ok(out.includes("\n\n---\n\n## 114-002"));
});

test("renderExportMarkdown 可帶結尾註記(例如未內嵌的圖片)", () => {
	const out = renderExportMarkdown([base], {
		label: "x",
		email: "me@x.test",
		now: 0,
		footnotes: ["3 張圖片因體積上限未內嵌。"],
	});
	assert.ok(out.trimEnd().endsWith("3 張圖片因體積上限未內嵌。"));
	const plain = renderExportMarkdown([base], { label: "x", email: "me@x.test", now: 0 });
	assert.ok(!plain.includes("未內嵌"));
});

test("空 items → 仍有檔頭,題數 0", () => {
	const out = renderExportMarkdown([], { label: "x", email: "me@x.test", now: 0 });
	assert.ok(out.includes("題數:0"));
});

test("contentDisposition:ASCII fallback + RFC 5987", () => {
	const cd = contentDisposition("收藏・心臟.md");
	assert.ok(cd.startsWith("attachment; "));
	const m = /filename="([^"]*)"/.exec(cd);
	assert.ok(m);
	// fallback 必須是純 ASCII,不含引號 / 反斜線
	assert.match(m![1], /^[\x20-\x7e]*$/);
	assert.ok(!m![1].includes('"'));
	assert.ok(cd.includes(`filename*=UTF-8''${encodeURIComponent("收藏・心臟.md")}`));
	// 引號與反斜線被中和
	assert.ok(!/filename="[^"]*[\\]/.test(contentDisposition('a"b\\c.md')));
	// 換行注入不會逃出 header
	assert.ok(!contentDisposition("a\r\nX-Evil: 1.md").includes("\n"));
});

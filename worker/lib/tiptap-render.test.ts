import { test } from "node:test";
import assert from "node:assert/strict";
import {
	docToMarkdown,
	docToHtml,
	docToPlainText,
	extractHighlightTexts,
} from "./tiptap-render.ts";

const doc = (...content: any[]) => ({ type: "doc", content });
const p = (...c: any[]) => ({ type: "paragraph", content: c });
const t = (text: string, marks?: any[]) => ({
	type: "text",
	text,
	...(marks && { marks }),
});

// ---------------------------------------------------------------- edge cases

test("空 doc / null / 非物件輸入 → 空字串", () => {
	assert.equal(docToMarkdown({ type: "doc", content: [] }), "");
	assert.equal(docToMarkdown(null), "");
	assert.equal(docToMarkdown(undefined), "");
	assert.equal(docToMarkdown("not a doc"), "");
	assert.equal(docToHtml(null), "");
	assert.equal(docToPlainText(null), "");
});

test("未知節點類型:降級遞迴 children,不丟例外、不吐 [object Object]", () => {
	assert.equal(
		docToMarkdown(doc({ type: "someFutureNode", content: [p(t("仍看得到"))] })),
		"仍看得到",
	);
	assert.equal(docToMarkdown(doc({ type: "atomFuture" })), "");
	assert.equal(
		docToHtml(doc({ type: "someFutureNode", content: [p(t("仍看得到"))] })),
		"<p>仍看得到</p>",
	);
	assert.ok(!docToMarkdown(doc({ type: "x", content: [p(t("a"))] })).includes("[object"));
});

// ------------------------------------------------------------------- inline

test("heading 依 level 轉 #", () => {
	assert.equal(
		docToMarkdown(doc({ type: "heading", attrs: { level: 2 }, content: [t("機轉")] })),
		"## 機轉",
	);
	assert.equal(
		docToMarkdown(doc({ type: "heading", attrs: { level: 1 }, content: [t("A")] })),
		"# A",
	);
	// level 缺失 / 超界 → 夾到 1..6
	assert.equal(docToMarkdown(doc({ type: "heading", content: [t("A")] })), "### A");
	assert.equal(
		docToMarkdown(doc({ type: "heading", attrs: { level: 9 }, content: [t("A")] })),
		"###### A",
	);
	assert.equal(
		docToHtml(doc({ type: "heading", attrs: { level: 2 }, content: [t("機轉")] })),
		"<h2>機轉</h2>",
	);
});

test("headingShift 把巢狀文件的標題往下壓,並夾在 h6", () => {
	const h = (level: number) => doc({ type: "heading", attrs: { level }, content: [t("A")] });
	assert.equal(docToMarkdown(h(1), { headingShift: 3 }), "#### A");
	assert.equal(docToMarkdown(h(3), { headingShift: 3 }), "###### A");
	assert.equal(docToMarkdown(h(6), { headingShift: 3 }), "###### A");
	assert.equal(docToHtml(h(1), { headingShift: 3 }), "<h4>A</h4>");
});

test("text marks:bold / italic / strike / code / highlight / link", () => {
	assert.equal(docToMarkdown(doc(p(t("A", [{ type: "bold" }])))), "**A**");
	assert.equal(docToMarkdown(doc(p(t("B", [{ type: "italic" }])))), "*B*");
	assert.equal(docToMarkdown(doc(p(t("C", [{ type: "strike" }])))), "~~C~~");
	assert.equal(docToMarkdown(doc(p(t("c", [{ type: "code" }])))), "`c`");
	assert.equal(
		docToMarkdown(doc(p(t("D", [{ type: "link", attrs: { href: "https://x.test" } }])))),
		"[D](https://x.test)",
	);
	// highlight = 使用者的畫記,用 ==…== 保留(Obsidian / Anki 皆通)
	assert.equal(docToMarkdown(doc(p(t("E", [{ type: "highlight" }])))), "==E==");
	// 未知 mark 靜默略過,文字仍在
	assert.equal(docToMarkdown(doc(p(t("F", [{ type: "superFuture" }])))), "F");
});

test("marks → HTML(code 最內層、link 最外層)", () => {
	assert.equal(docToHtml(doc(p(t("A", [{ type: "bold" }])))), "<p><b>A</b></p>");
	assert.equal(docToHtml(doc(p(t("E", [{ type: "highlight" }])))), "<p><mark>E</mark></p>");
	assert.equal(
		docToHtml(doc(p(t("D", [{ type: "link", attrs: { href: "https://x.test" } }])))),
		'<p><a href="https://x.test">D</a></p>',
	);
	// javascript: 之類的 href 被丟掉,只留文字
	assert.equal(
		docToHtml(doc(p(t("X", [{ type: "link", attrs: { href: "javascript:alert(1)" } }])))),
		"<p>X</p>",
	);
	assert.equal(
		docToMarkdown(doc(p(t("X", [{ type: "link", attrs: { href: "javascript:alert(1)" } }])))),
		"X",
	);
});

test("docToHtml 跳脫 & < > 與屬性引號", () => {
	assert.equal(docToHtml(doc(p(t('a & b < c > d "e"')))), "<p>a &amp; b &lt; c &gt; d &quot;e&quot;</p>");
	assert.equal(
		docToHtml(doc(p(t("L", [{ type: "link", attrs: { href: 'https://x.test/?a="1"&b=2' } }])))),
		'<p><a href="https://x.test/?a=&quot;1&quot;&amp;b=2">L</a></p>',
	);
});

test("hardBreak / horizontalRule", () => {
	assert.equal(docToMarkdown(doc(p(t("a"), { type: "hardBreak" }, t("b")))), "a  \nb");
	assert.equal(docToHtml(doc(p(t("a"), { type: "hardBreak" }, t("b")))), "<p>a<br>b</p>");
	assert.equal(docToMarkdown(doc({ type: "horizontalRule" })), "---");
	assert.equal(docToHtml(doc({ type: "horizontalRule" })), "<hr>");
});

// -------------------------------------------------------------------- lists

test("巢狀 list 縮排正確", () => {
	const nested = doc({
		type: "bulletList",
		content: [
			{
				type: "listItem",
				content: [
					p(t("外層")),
					{
						type: "bulletList",
						content: [{ type: "listItem", content: [p(t("內層"))] }],
					},
				],
			},
		],
	});
	assert.equal(docToMarkdown(nested), "- 外層\n  - 內層");
	assert.equal(
		docToHtml(nested),
		"<ul><li><p>外層</p><ul><li><p>內層</p></li></ul></li></ul>",
	);
});

test("orderedList 編號遞增,尊重 start", () => {
	const li = (s: string) => ({ type: "listItem", content: [p(t(s))] });
	assert.equal(
		docToMarkdown(doc({ type: "orderedList", content: [li("甲"), li("乙"), li("丙")] })),
		"1. 甲\n2. 乙\n3. 丙",
	);
	assert.equal(
		docToMarkdown(
			doc({ type: "orderedList", attrs: { start: 3 }, content: [li("甲"), li("乙")] }),
		),
		"3. 甲\n4. 乙",
	);
});

test("blockquote 每行前綴 >", () => {
	assert.equal(docToMarkdown(doc({ type: "blockquote", content: [p(t("引")), p(t("述"))] })), "> 引\n>\n> 述");
	assert.equal(
		docToHtml(doc({ type: "blockquote", content: [p(t("引"))] })),
		"<blockquote><p>引</p></blockquote>",
	);
});

test("codeBlock 帶 language", () => {
	const cb = (lang: string | null, s: string) => ({
		type: "codeBlock",
		attrs: { language: lang },
		content: [t(s)],
	});
	assert.equal(docToMarkdown(doc(cb("ts", "const a = 1;"))), "```ts\nconst a = 1;\n```");
	assert.equal(docToMarkdown(doc(cb(null, "plain"))), "```\nplain\n```");
	assert.equal(
		docToHtml(doc(cb("ts", "a < b"))),
		'<pre><code class="language-ts">a &lt; b</code></pre>',
	);
});

// -------------------------------------------------------------------- table

test("table → GFM pipe table(首列為表頭)", () => {
	const cell = (type: string, s: string) => ({ type, content: [p(t(s))] });
	const table = doc({
		type: "table",
		content: [
			{
				type: "tableRow",
				content: [cell("tableHeader", "藥"), cell("tableHeader", "機轉")],
			},
			{
				type: "tableRow",
				content: [cell("tableCell", "Imatinib"), cell("tableCell", "BCR-ABL1")],
			},
		],
	});
	assert.equal(
		docToMarkdown(table),
		"| 藥 | 機轉 |\n| --- | --- |\n| Imatinib | BCR-ABL1 |",
	);
	assert.equal(
		docToHtml(table),
		"<table><tr><th>藥</th><th>機轉</th></tr><tr><td>Imatinib</td><td>BCR-ABL1</td></tr></table>",
	);
	// 沒有 tableRow 的 table 不輸出
	assert.equal(docToMarkdown(doc({ type: "table", content: [] })), "");
});

test("表格儲存格內的 | 被跳脫,換行被壓平", () => {
	const table = doc({
		type: "table",
		content: [
			{ type: "tableRow", content: [{ type: "tableHeader", content: [p(t("a|b"))] }] },
			{ type: "tableRow", content: [{ type: "tableCell", content: [p(t("c")), p(t("d"))] }] },
		],
	});
	assert.equal(docToMarkdown(table), "| a\\|b |\n| --- |\n| c d |");
});

// -------------------------------------------------------------------- atoms

test("image → ![](/img/k),src 經 sanitize(拒 javascript:)", () => {
	const img = (src: string, alt?: string) => ({ type: "image", attrs: { src, alt } });
	assert.equal(docToMarkdown(doc(img("/img/k.png"))), "![](/img/k.png)");
	assert.equal(docToMarkdown(doc(img("/img/k.png", "圖"))), "![圖](/img/k.png)");
	assert.equal(docToMarkdown(doc(img("https://x.test/a.png"))), "![](https://x.test/a.png)");
	// 相對路徑 / javascript: / data: 一律丟棄
	assert.equal(docToMarkdown(doc(img("javascript:alert(1)"))), "");
	assert.equal(docToMarkdown(doc(img("../secret.png"))), "");
	assert.equal(docToMarkdown(doc(img("data:image/png;base64,AAAA"))), "");
	assert.equal(docToHtml(doc(img("/img/k.png"))), '<img src="/img/k.png">');
});

test("opts.imageSrc 可改寫 src;回 null 則略過該圖", () => {
	const d = doc({ type: "image", attrs: { src: "/img/k.png" } });
	assert.equal(
		docToMarkdown(d, { imageSrc: (s) => `https://h.test${s}` }),
		"![](https://h.test/img/k.png)",
	);
	assert.equal(docToMarkdown(d, { imageSrc: () => null }), "");
	assert.equal(docToHtml(d, { imageSrc: () => null }), "");
});

test("mention → @label(無 label 退回 id)", () => {
	const m = (attrs: any) => doc(p({ type: "mention", attrs }));
	assert.equal(docToMarkdown(m({ id: "a@b.test", label: "小明" })), "@小明");
	assert.equal(docToMarkdown(m({ id: "a@b.test" })), "@a@b.test");
	assert.equal(docToHtml(m({ id: "a@b.test", label: "小明" })), '<p><span class="mention">@小明</span></p>');
	assert.equal(docToPlainText(m({ id: "a@b.test", label: "小明" })), "@小明");
});

test("questionRef → @114-001;有 base 時 md 帶站內連結", () => {
	const d = doc(p({ type: "questionRef", attrs: { id: "114-001" } }));
	assert.equal(docToMarkdown(d), "@114-001");
	assert.equal(
		docToMarkdown(d, { questionRefBase: "https://h.test/q/" }),
		"[@114-001](https://h.test/q/114-001)",
	);
	assert.equal(
		docToHtml(d, { questionRefBase: "https://h.test/q/" }),
		'<p><a class="qref" href="https://h.test/q/114-001">@114-001</a></p>',
	);
	assert.equal(docToHtml(d), '<p><span class="qref">@114-001</span></p>');
});

// --------------------------------------------------------------- plain text

test("docToPlainText 剝除所有標記、區塊間換行", () => {
	const d = doc(
		{ type: "heading", attrs: { level: 2 }, content: [t("機轉")] },
		p(t("A", [{ type: "bold" }]), t("B", [{ type: "highlight" }])),
		{
			type: "bulletList",
			content: [{ type: "listItem", content: [p(t("項目"))] }],
		},
	);
	assert.equal(docToPlainText(d), "機轉\nAB\n項目");
	assert.equal(docToPlainText(doc({ type: "doc", content: [] })), "");
});

// ---------------------------------------------------------------- highlights

test("extractHighlightTexts 抽出畫記片段(相鄰片段合併、去重、忽略空白)", () => {
	const d = doc(
		p(t("前"), t("重點一", [{ type: "highlight" }]), t("後")),
		p(t("重點", [{ type: "highlight" }]), t("二", [{ type: "highlight" }])),
		p(t("   ", [{ type: "highlight" }])),
		p(t("重點一", [{ type: "highlight" }])),
	);
	assert.deepEqual(extractHighlightTexts(d), ["重點一", "重點二"]);
	assert.deepEqual(extractHighlightTexts(null), []);
	assert.deepEqual(extractHighlightTexts(doc(p(t("無畫記")))), []);
});

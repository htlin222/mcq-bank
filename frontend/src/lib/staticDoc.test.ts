import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { renderStaticDoc, safeUrl } from "./staticDoc.ts";

const html = (doc: unknown) =>
	renderToStaticMarkup(createElement("div", null, ...renderStaticDoc(doc)));

const doc = (...content: any[]) => ({ type: "doc", content });
const para = (...content: any[]) => ({ type: "paragraph", content });
const text = (t: string, marks?: any[]) => ({ type: "text", text: t, marks });

test("區塊節點畫成對應的標籤", () => {
	const out = html(
		doc(
			{ type: "heading", attrs: { level: 2 }, content: [text("標題")] },
			para(text("內文")),
			{
				type: "bulletList",
				content: [{ type: "listItem", content: [para(text("項目"))] }],
			},
			{ type: "blockquote", content: [para(text("引用"))] },
			{ type: "horizontalRule" },
		),
	);
	assert.match(out, /<h2>標題<\/h2>/);
	assert.match(out, /<p>內文<\/p>/);
	assert.match(out, /<ul><li><p>項目<\/p><\/li><\/ul>/);
	assert.match(out, /<blockquote><p>引用<\/p><\/blockquote>/);
	assert.match(out, /<hr\/>/);
});

test("mark 由內往外包,順序照 marks 陣列", () => {
	const out = html(
		doc(para(text("重點", [{ type: "bold" }, { type: "highlight" }]))),
	);
	assert.match(out, /<mark><strong>重點<\/strong><\/mark>/);
});

test("沒有 mark 的文字不包多餘的 span", () => {
	assert.equal(html(doc(para(text("純文字")))), "<div><p>純文字</p></div>");
});

// —— 這一組是這支檔案存在的主要理由 ——
// content_json 是使用者可寫的欄位,渲染器是它唯一的把關點。

test("javascript: 連結降級成純文字,不留下 <a>", () => {
	const out = html(
		doc(
			para(
				text("點我", [
					{ type: "link", attrs: { href: "javascript:alert(1)" } },
				]),
			),
		),
	);
	assert.equal(out, "<div><p>點我</p></div>");
});

test("safeUrl 擋掉會執行程式的協定,放行站內與一般網址", () => {
	// 大小寫混雜、夾控制字元 —— 都得靠 URL 解析正規化才擋得住,字首比對會漏。
	assert.equal(safeUrl("JaVaScRiPt:alert(1)"), null);
	assert.equal(safeUrl("java\tscript:alert(1)"), null);
	assert.equal(safeUrl("data:text/html,<script>"), null);
	assert.equal(safeUrl("vbscript:msgbox"), null);
	// protocol-relative 的絕對網址長得像相對路徑,是最容易漏的一個。
	assert.equal(safeUrl("//evil.example/x"), null);
	assert.equal(safeUrl(""), null);
	assert.equal(safeUrl(undefined), null);
	assert.equal(safeUrl("/q/114-001"), "/q/114-001");
	assert.equal(safeUrl("/img/abc"), "/img/abc");
	assert.equal(safeUrl("https://a.example/x"), "https://a.example/x");
	assert.equal(safeUrl("mailto:a@b.c"), "mailto:a@b.c");
});

test("圖片的 src 走同一道關,擋掉的整個不渲染", () => {
	assert.equal(
		html(doc({ type: "image", attrs: { src: "javascript:alert(1)" } })),
		"<div></div>",
	);
	assert.match(
		html(doc({ type: "image", attrs: { src: "/img/k", alt: "抹片" } })),
		/<img src="\/img\/k"/,
	);
});

test("站外連結帶 noopener noreferrer", () => {
	const out = html(
		doc(
			para(
				text("外連", [{ type: "link", attrs: { href: "https://a.example" } }]),
			),
		),
	);
	assert.match(out, /rel="noopener noreferrer"/);
});

test("屬性不會被當成標記注入", () => {
	const out = html(doc(para(text('"><img onerror=alert(1)>'))));
	assert.ok(!out.includes("<img"), out);
});

// —— 未知節點:整份文件不准因為一個節點就消失 ——

test("認不得的節點只跳過自己,子節點與後面的內容照畫", () => {
	const out = html(
		doc(
			para(text("前")),
			{ type: "someFutureNode", content: [para(text("裡面"))] },
			para(text("後")),
		),
	);
	assert.match(out, /前/);
	assert.match(out, /裡面/);
	assert.match(out, /後/);
});

test("認不得的 mark 不會吃掉文字", () => {
	assert.match(html(doc(para(text("字", [{ type: "underline" }])))), /字/);
});

test("snake_case 舊節點沿用 normalizeTiptapDoc 的正規化", () => {
	const out = html({
		type: "doc",
		content: [
			{
				type: "bullet_list",
				content: [{ type: "list_item", content: [para(text("舊拼法"))] }],
			},
		],
	});
	assert.match(out, /<ul><li><p>舊拼法<\/p><\/li><\/ul>/);
});

test("空的 / 壞掉的輸入回空陣列而不是丟例外", () => {
	assert.deepEqual(renderStaticDoc(null), []);
	assert.deepEqual(renderStaticDoc("不是文件"), []);
	assert.deepEqual(renderStaticDoc(undefined), []);
});

// —— DOM 形狀是契約:樣式與點擊攔截都靠這些屬性認人 ——

test("mention / questionRef 的 class 與 data 屬性跟 extension 一致", () => {
	const out = html(
		doc(
			para(
				{ type: "mention", attrs: { id: "a@b.c", label: "某人" } },
				{ type: "questionRef", attrs: { id: "114-010" } },
			),
		),
	);
	assert.match(
		out,
		/<span class="mention" data-type="mention" data-id="a@b.c">@某人<\/span>/,
	);
	assert.match(
		out,
		/<a class="qref" href="\/q\/114-010" data-question-ref="114-010">@114-010<\/a>/,
	);
});

test("表格自帶 .table-scroll 外框(styles.css 靠它做左右捲)", () => {
	const out = html(
		doc({
			type: "table",
			content: [
				{
					type: "tableRow",
					content: [
						{ type: "tableHeader", content: [para(text("欄"))] },
						{
							type: "tableCell",
							attrs: { colspan: 2 },
							content: [para(text("格"))],
						},
					],
				},
			],
		}),
	);
	assert.match(out, /<div class="table-scroll"><table><tbody>/);
	assert.match(out, /<th><p>欄<\/p><\/th>/);
	// React 18 保留 colSpan 的大小寫;HTML 屬性名不分大小寫,瀏覽器照樣認得。
	assert.match(out, /<td colspan="2"><p>格<\/p><\/td>/i);
});

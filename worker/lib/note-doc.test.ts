import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeNoteDoc, externalImages, safeImageSrc } from "./note-doc.ts";

// Narrow SanitizeResult to the success shape (assert.ok doesn't narrow for TS).
function ok(input: unknown) {
	const r = sanitizeNoteDoc(input);
	if (!r.ok) throw new assert.AssertionError({ message: `expected success, got: ${r.error}` });
	return r;
}

const doc = (content: any[]) => ({ type: "doc", content });
const p = (text: string, marks?: any[]) => ({
	type: "paragraph",
	content: [{ type: "text", text, ...(marks ? { marks } : {}) }],
});

test("rejects non-doc input", () => {
	assert.equal(sanitizeNoteDoc(null).ok, false);
	assert.equal(sanitizeNoteDoc({ type: "paragraph" }).ok, false);
	assert.equal(sanitizeNoteDoc(doc([])).ok, false);
});

test("passes through core blocks and marks", () => {
	const input = doc([
		{ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "T" }] },
		p("hello", [{ type: "bold" }, { type: "highlight" }]),
		{ type: "horizontalRule" },
	]);
	const r = sanitizeNoteDoc(input);
	assert.deepEqual(r.doc, input);
});

test("clamps heading level to 1..3", () => {
	const r = ok(
		doc([{ type: "heading", attrs: { level: 6 }, content: [{ type: "text", text: "x" }] }]),
	);
	assert.equal(r.doc.content![0].attrs!.level, 3);
});

test("drops unknown marks, keeps text", () => {
	const r = ok(doc([p("x", [{ type: "textStyle", attrs: { color: "red" } }])]));
	const textNode = r.doc.content![0].content![0];
	assert.equal(textNode.text, "x");
	assert.equal(textNode.marks, undefined);
	assert.ok(r.dropped.includes("mark:textStyle"));
});

test("link marks: safe hrefs kept with rel, javascript: dropped", () => {
	const r = ok(
		doc([
			p("ok", [{ type: "link", attrs: { href: "https://example.com" } }]),
			p("bad", [{ type: "link", attrs: { href: "javascript:alert(1)" } }]),
		]),
	);
	const [okPara, bad] = r.doc.content!;
	assert.equal(okPara.content![0].marks![0].attrs!.href, "https://example.com");
	assert.equal(bad.content![0].marks, undefined);
});

test("unknown block nodes are dropped but children salvaged", () => {
	const r = ok(doc([{ type: "callout", content: [p("inside")] }]));
	assert.equal(r.doc.content![0].type, "paragraph");
	assert.equal(r.doc.content![0].content![0].text, "inside");
	assert.ok(r.dropped.includes("callout"));
});

test("mention degrades to plain @text", () => {
	const r = ok(
		doc([
			{
				type: "paragraph",
				content: [{ type: "mention", attrs: { id: "a@b.c", label: "小明" } }],
			},
		]),
	);
	assert.equal(r.doc.content![0].content![0].text, "@小明");
});

test("stray inline nodes at block level get wrapped in a paragraph", () => {
	const r = ok(doc([{ type: "text", text: "loose" }]));
	assert.equal(r.doc.content![0].type, "paragraph");
});

test("lists keep structure; empty lists dropped", () => {
	const r = ok(
		doc([
			{ type: "bulletList", content: [{ type: "listItem", content: [p("a")] }] },
			{ type: "bulletList", content: [] },
		]),
	);
	assert.equal(r.doc.content!.length, 1);
	assert.equal(r.doc.content![0].content![0].type, "listItem");
});

test("tables survive with cells normalized", () => {
	const r = ok(
		doc([
			{
				type: "table",
				content: [
					{
						type: "tableRow",
						content: [
							{ type: "tableHeader", content: [p("h")] },
							{ type: "tableCell", content: [] },
						],
					},
				],
			},
		]),
	);
	const row = r.doc.content![0].content![0];
	assert.equal(row.content![1].content![0].type, "paragraph");
});

test("images: http(s) collected for sideload, data: dropped, /img/ kept", () => {
	const r = ok(
		doc([
			{ type: "image", attrs: { src: "https://x.com/a.png", alt: "fig" } },
			{ type: "image", attrs: { src: "data:image/png;base64,AAAA" } },
			{ type: "image", attrs: { src: "/img/img/uuid.png" } },
		]),
	);
	assert.equal(r.doc.content!.length, 2);
	assert.equal(r.images.length, 2);
	assert.equal(externalImages(r.images).length, 1);
});

test("codeBlock collapses to plain text", () => {
	const r = ok(
		doc([
			{
				type: "codeBlock",
				content: [
					{ type: "text", text: "a", marks: [{ type: "bold" }] },
					{ type: "text", text: "b" },
				],
			},
		]),
	);
	assert.deepEqual(r.doc.content![0].content, [{ type: "text", text: "ab" }]);
});

test("safeImageSrc", () => {
	assert.equal(safeImageSrc("https://a/b.png"), "https://a/b.png");
	assert.equal(safeImageSrc("/img/img/x.png"), "/img/img/x.png");
	assert.equal(safeImageSrc("blob:https://a/b"), null);
	assert.equal(safeImageSrc("//a/b.png"), null);
});

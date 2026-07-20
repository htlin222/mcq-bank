import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeImportedDoc } from "./sanitize-import.ts";

// Loosely typed on purpose — these build fixture docs, not production nodes.
const t = (text: string, marks?: any[]): any =>
	marks ? { type: "text", text, marks } : { type: "text", text };
const p = (...content: any[]): any => ({ type: "paragraph", content });
const doc = (...content: any[]): any => ({ type: "doc", content });

const plain = (n: any): string =>
	n.type === "text" ? n.text : (n.content || []).map(plain).join("");

// --- A. text scrubbing -------------------------------------------------------

test("strips the stray closing tag + truncated citation marker (real 114-048 heading)", () => {
	// Verbatim from personal_notes: the heading kept a text node holding only
	// residue after the bold run.
	const out: any = sanitizeImportedDoc(
		doc({
			type: "heading",
			attrs: { level: 3 },
			content: [t("一線治療選擇", [{ type: "bold" }]), t("</h3> [[1,1")],
		}),
	);
	assert.deepEqual(out.content[0].content, [
		t("一線治療選擇", [{ type: "bold" }]),
	]);
});

test("handles every truncation the citation marker showed up as", () => {
	for (const junk of ["</h3> [[1,1", "</h3> [[", "</h3> [[1", "</h3> "]) {
		const out: any = sanitizeImportedDoc(doc(p(t("標題"), t(junk))));
		assert.equal(plain(out), "標題", `failed on ${JSON.stringify(junk)}`);
	}
});

test("strips a complete [[1,1]] marker and an orphan closing half", () => {
	assert.equal(plain(sanitizeImportedDoc(doc(p(t("甲[[1,1]]乙"))))), "甲乙");
	assert.equal(plain(sanitizeImportedDoc(doc(p(t("甲 ]]乙"))))), "甲 乙");
	assert.equal(plain(sanitizeImportedDoc(doc(p(t("甲[[1-2]乙"))))), "甲乙");
});

test("leaves a real [[wiki link]] alone", () => {
	// The bare-`[[` rule must not turn user markdown into mush.
	const src = doc(p(t("see [[wiki link]] and [[參考]]")));
	assert.deepEqual(sanitizeImportedDoc(src), src);
});

test("keeps a whitespace-only separator between marks", () => {
	// bold + " ：" pattern is everywhere in these notes; trimming it would
	// weld words together.
	const out: any = sanitizeImportedDoc(
		doc(p(t("骨髓浸潤", [{ type: "bold" }]), t("："), t(" 小淋巴漿細胞"))),
	);
	assert.equal(plain(out), "骨髓浸潤： 小淋巴漿細胞");
});

test("leaves ordinary prose alone", () => {
	const src = doc(p(t("MYD88 L265P 突變率 90-95%，IgM > 3 g/dL。")));
	assert.deepEqual(sanitizeImportedDoc(src), src);
});

test("does not touch a code block", () => {
	const src = doc({
		type: "codeBlock",
		content: [t("<h3>title</h3> arr[[1,1]]")],
	});
	assert.deepEqual(sanitizeImportedDoc(src), src);
});

// --- B. chrome blocks --------------------------------------------------------

test("drops OE figure chrome and status lines", () => {
	const out: any = sanitizeImportedDoc(
		doc(
			p(t("Figure 3. NF-kB pathway in WM.")),
			p(t("Used under license from Wiley.")),
			p(t("Feedback")),
			p(t("Done")),
			p(t("Analyzed query, searched for evidence")),
			p(t("真正的內容")),
		),
	);
	assert.deepEqual(out.content.map(plain), [
		"Figure 3. NF-kB pathway in WM.",
		"真正的內容",
	]);
});

test("drops the trailing follow-up invite", () => {
	const out: any = sanitizeImportedDoc(
		doc(
			p(t("結論段落。")),
			p(t("您是否想進一步了解 WM 與其他 B 細胞淋巴瘤的比較?")),
		),
	);
	assert.deepEqual(out.content.map(plain), ["結論段落。"]);
});

test("keeps a question that merely ends in a question mark", () => {
	const src = doc(p(t("WM 的診斷閾值是多少?")));
	assert.deepEqual(sanitizeImportedDoc(src), src);
});

// --- C. empty-shell collapse -------------------------------------------------

test("collapses shells left behind, but keeps table shape", () => {
	const out: any = sanitizeImportedDoc(
		doc(
			p(t("[[1,1]]")), // paragraph that was pure residue
			{
				type: "table",
				content: [
					{
						type: "tableRow",
						content: [
							{ type: "tableHeader", content: [p(t("疾病"))] },
							{ type: "tableHeader", content: [p(t("[["))] },
						],
					},
					{
						type: "tableRow",
						content: [
							{ type: "tableCell", content: [p(t("]]"))] },
							{ type: "tableCell", content: [p(t("</p>"))] },
						],
					},
				],
			},
		),
	);
	// Residue-only paragraph gone; table survives.
	assert.equal(out.content.length, 1);
	assert.equal(out.content[0].type, "table");
	// Row 1 kept both cells (one emptied → placeholder paragraph, not removed).
	const row1 = out.content[0].content[0];
	assert.equal(row1.content.length, 2);
	assert.deepEqual(row1.content[1].content, [{ type: "paragraph" }]);
	// Row 2 went fully blank → dropped.
	assert.equal(out.content[0].content.length, 1);
});

test("keeps void nodes that legitimately have no content", () => {
	const src = doc(
		{ type: "image", attrs: { src: "/img/abc" } },
		{ type: "horizontalRule" },
	);
	assert.deepEqual(sanitizeImportedDoc(src), src);
});

test("does not mutate the input", () => {
	const src = doc(p(t("甲[[1,1]]乙")));
	const snapshot = JSON.stringify(src);
	sanitizeImportedDoc(src);
	assert.equal(JSON.stringify(src), snapshot);
});

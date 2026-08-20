import assert from "node:assert/strict";
import { test } from "node:test";
import { flatSelection, richSelection } from "./selectionText.ts";

// 瀏覽器真的會交出來的形狀:跨區塊選取帶著 HTML 原始碼的縮排。
const CROSS_BLOCK = "第一段的內容\n\n    第二段開頭有縮排\n\n\n\n第三段";

test("flat 把換行壓成空格(錨定與長度上限都靠它)", () => {
	assert.equal(
		flatSelection("PT may be prolonged\nwith rivaroxaban"),
		"PT may be prolonged with rivaroxaban",
	);
	assert.equal(flatSelection("  前後空白  "), "前後空白");
	assert.equal(flatSelection("多\t\t個   空白"), "多 個 空白");
});

test("rich 保留換行 —— 這是 #165 的核心", () => {
	const out = richSelection("第一行\n第二行\n第三行");
	assert.equal(out, "第一行\n第二行\n第三行");
	assert.equal(out.split("\n").length, 3);
});

test("rich 去掉行首縮排,否則 Telegram 上每行前面都多一截空白", () => {
	assert.equal(richSelection("    有縮排的一行\n\t另一行"), "有縮排的一行\n另一行");
});

test("rich 把行內的連續空白壓平,但不跨行", () => {
	assert.equal(richSelection("a    b\nc    d"), "a b\nc d");
});

test("rich 把三個以上連續換行收成一個空行", () => {
	assert.equal(richSelection(CROSS_BLOCK), "第一段的內容\n\n第二段開頭有縮排\n\n第三段");
});

test("rich 保留單一空行(段落之間的間隔是有意義的)", () => {
	assert.equal(richSelection("上段\n\n下段"), "上段\n\n下段");
});

test("兩者對單行輸入的結果一致", () => {
	const one = "  單獨一行的選取  ";
	assert.equal(richSelection(one), flatSelection(one));
});

test("rich 不會製造出 flat 沒有的內容", () => {
	// 除了換行以外,兩者的可見字元應完全相同 —— rich 只該影響空白。
	const raw = "Alpha\n  Beta   Gamma\n\n\nDelta";
	assert.equal(
		richSelection(raw).replace(/\s+/g, " "),
		flatSelection(raw),
	);
});

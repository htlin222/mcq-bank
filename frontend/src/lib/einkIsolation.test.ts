// 亮/暗主題必須完全不受電子紙那層覆寫影響。
//
// 那一層是「全滅 + 撈回」:`[class*="bg-"]` 之類的通則把全站塗成黑白。它唯一的
// 圍籬就是每條選擇器前面那個 `.eink` —— 漏掉一條,那條通則就會在亮模式下生效,
// 而且**是無聲的**:塗白的東西在淺色底上看起來只是「怪怪的、有點太亮」,不會報錯,
// 也不會被顏色掃描抓到(那支測試只在 e-ink 下跑)。
//
// 所以這裡不驗畫面,驗的是那道圍籬本身:e-ink 區塊裡的每一條選擇器,都必須帶
// eink 限定。純文字檢查,不需要瀏覽器,CI 一定會跑到。
//
// ⚠️ 逗號要在**括號深度 0** 才算分隔符。`:is(:focus, :focus-visible)` 與
// `:where([class*="absolute"], [class*="fixed"])` 內部的逗號不是 —— 天真地
// `split(',')` 會把一條規則切成好幾段,然後回報三條不存在的違規。這個坑實際
// 踩過:第一版就是這樣誤報,差點讓人去「修」一條本來就正確的規則。

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CSS = path.join(HERE, "..", "styles.css");

/** 只在括號深度 0 的逗號切開。 */
function splitTopLevel(sel: string): string[] {
	const out: string[] = [];
	let depth = 0;
	let cur = "";
	for (const ch of sel) {
		if (ch === "(" || ch === "[") depth++;
		else if (ch === ")" || ch === "]") depth--;
		if (ch === "," && depth === 0) {
			out.push(cur);
			cur = "";
		} else {
			cur += ch;
		}
	}
	out.push(cur);
	return out.map((s) => s.trim()).filter(Boolean);
}

/** 取出頂層規則的選擇器(跳過註解與巢狀區塊內容)。 */
function topLevelSelectors(css: string): string[] {
	const noComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
	const sels: string[] = [];
	let depth = 0;
	let buf = "";
	for (const ch of noComments) {
		if (ch === "{") {
			if (depth === 0) sels.push(buf.trim());
			buf = "";
			depth++;
		} else if (ch === "}") {
			depth--;
			buf = "";
		} else if (depth === 0) {
			buf += ch;
		}
	}
	return sels.filter((s) => s && !s.startsWith("@"));
}

function einkBlock(): string {
	const src = fs.readFileSync(CSS, "utf8");
	const i = src.indexOf("html.eink {");
	assert.ok(
		i > 0,
		"styles.css 找不到 `html.eink {` —— e-ink 區塊的起點變了,這支測試會在什麼都沒檢查的情況下全綠",
	);
	return src.slice(i);
}

test("e-ink 區塊的每一條選擇器都帶 eink 限定 —— 亮/暗主題碰不到它", () => {
	const sels = topLevelSelectors(einkBlock());

	// 正面斷言:真的解析到規則。少了它,選擇器格式一變就變成空掃的綠燈。
	assert.ok(
		sels.length > 20,
		`只解析到 ${sels.length} 條規則,遠少於預期 —— 解析器跟 CSS 格式對不上了`,
	);

	const leaked: string[] = [];
	for (const sel of sels) {
		for (const part of splitTopLevel(sel)) {
			if (!part.includes("eink")) leaked.push(part.replace(/\s+/g, " "));
		}
	}

	assert.deepEqual(
		leaked,
		[],
		`這些 e-ink 規則沒有 eink 限定,會洩漏到亮/暗主題(共 ${leaked.length} 條)`,
	);
});

test("解析器認得 :is()/:where() 內部的逗號 —— 否則會誤報成違規", () => {
	// 這條守的是上面那支測試的「儀器」本身。第一版就是被這種選擇器騙到,
	// 回報了三條不存在的違規。
	const sel =
		'.eink :is(:focus, :focus-visible):not(:where([class*="absolute"], [class*="fixed"]))';
	assert.deepEqual(splitTopLevel(sel), [sel]);

	// 真正的頂層逗號仍然要切開
	assert.deepEqual(splitTopLevel(".eink a, .eink b"), [".eink a", ".eink b"]);

	// 而且真的漏掉 eink 的話要抓得到
	const bad = splitTopLevel('.eink a, [class*="bg-"]');
	assert.deepEqual(bad.filter((s) => !s.includes("eink")), ['[class*="bg-"]']);
});

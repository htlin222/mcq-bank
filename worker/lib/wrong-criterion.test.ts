import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { WRONG_PREDICATE, WRONG_WHERE } from "./wrong-criterion.ts";

test("判準是最近一次答錯,不是累積正確率", () => {
	assert.match(WRONG_WHERE, /last_correct = 0/);
	// 舊判準留在原地的話,清單與匯出會回到「錯過就永遠出不去」。
	assert.ok(!WRONG_WHERE.includes("times_correct * 100"));
});

test("predicate 是 where 包一層括號 —— 兩者不會各自漂移", () => {
	assert.equal(WRONG_PREDICATE, `(${WRONG_WHERE})`);
});

test("別名固定是 rp", () => {
	for (const col of ["times_seen", "last_correct"]) {
		assert.ok(WRONG_WHERE.includes(`rp.${col}`), `${col} 沒有帶別名`);
	}
});

// 這條是這個模組存在的理由:三個消費端不准再各自寫一份。掃的是原始碼,因為
// 「有沒有重複定義」看執行結果是看不出來的 —— 兩份一模一樣的 SQL 也會全綠。
test("沒有人再自己寫一份錯題判準", () => {
	const root = path.join(
		path.dirname(new URL(import.meta.url).pathname),
		"..",
	);
	const files = [];
	const walk = (dir) => {
		for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
			const p = path.join(dir, e.name);
			if (e.isDirectory()) walk(p);
			else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) files.push(p);
		}
	};
	walk(root);
	// 對照組:真的掃到東西了嗎(cwd 一變就會退化成空掃的綠燈)。
	assert.ok(files.length > 20, `只掃到 ${files.length} 個檔案,掃描範圍不對`);

	const offenders = [];
	for (const f of files) {
		if (f.endsWith("wrong-criterion.ts")) continue;
		const src = fs.readFileSync(f, "utf8");
		// 舊判準的指紋。註解裡出現不算 —— 那是在解釋為什麼不再這樣寫。
		for (const line of src.split("\n")) {
			const code = line.trim();
			if (code.startsWith("//") || code.startsWith("*")) continue;
			if (/times_correct \* 100 \/ rp\.times_seen\) < 100/.test(code))
				offenders.push(path.basename(f));
			if (/rp\.times_correct < rp\.times_seen/.test(code))
				offenders.push(path.basename(f));
		}
	}
	assert.deepEqual([...new Set(offenders)], [], "還有地方自己寫了一份錯題判準");
});

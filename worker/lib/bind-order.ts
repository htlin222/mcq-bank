// D1 的 bind 是**位置對應**的,而位置錯了不會報錯 —— 只會讓某個 JOIN 永遠不匹配,
// 然後某個欄位靜靜變成 NULL。
//
// 這不是假想的風險。2026-08-27 在成績頁真的發生:#184 為了加
// `LEFT JOIN review_progress rp ON ... AND rp.user_email = ?`,把
// `.bind(sid, sid)` 改成 `.bind(sid, email, sid)` —— 新的 `?` 加在 SQL 的**最前面**
// (LEFT JOIN 排在算用時的子查詢之前),但 `email` 被插在**中間**。兩個後果都無聲:
//
//   rp.user_email = <session id>   → 永遠不匹配 → review_last_chosen 全是 NULL
//                                  → 成績頁把每一題答對的都當成「待登記」(79 題),
//                                    而伺服器自己的查詢算出來要登記 0 題
//   attempts.session_id = <email>  → 永遠不匹配 → 每題用時全部顯示「—」
//
// `worker/routes/questions.ts` 早就有一句註解在提醒這件事(「Bind params are
// positional — keep these arrays in the same order the placeholders appear」),
// 而註解沒有擋住它。所以改成一條讀得到的規則。
//
// ⚠️ **這支只認得幾個「欄名幾乎決定了該綁什麼」的欄位。** 它不是通用的 SQL 檢查,
// 也做不到 —— 通用地判斷第 N 個 `?` 該綁哪個變數需要真的懂那段 SQL 的語意。
// 收窄到這幾個欄位是刻意的:誤報一多就會有人把整支停用,那比沒有更糟。

/** 欄名 → 綁進去的東西名字裡「應該」出現的字樣(任一個命中就算過)。 */
const EXPECTED: { column: string; wants: string[] }[] = [
	{ column: "user_email", wants: ["email"] },
	{ column: "session_id", wants: ["sid", "session"] },
];

export interface BindIssue {
	/** 這是第幾個 `?`(1-based)。 */
	index: number;
	column: string;
	/** 實際綁進去的運算式原文。 */
	bound: string;
	/** 原始碼裡的行號(1-based),指向 `.prepare(`。 */
	line: number;
}

/**
 * 把 `.bind(a, b, c)` 的引數切開。**不能用 `split(",")`** —— `Math.min(a, b)`
 * 這種引數裡面的逗號不是分隔符。同 einkIsolation 那支對 `:is(a, b)` 的處理:
 * 逗號要在括號深度 0 才算數。
 */
export function splitArgs(src: string): string[] {
	const out: string[] = [];
	let depth = 0;
	let cur = "";
	for (const ch of src) {
		if (ch === "(" || ch === "[" || ch === "{") depth++;
		else if (ch === ")" || ch === "]" || ch === "}") depth--;
		if (ch === "," && depth === 0) {
			out.push(cur.trim());
			cur = "";
			continue;
		}
		cur += ch;
	}
	if (cur.trim()) out.push(cur.trim());
	return out;
}

/**
 * `?` 前面那一段裡,最後被比較的欄位是哪一個。
 *
 * 只認 `<column> = ?` 與 `<column> IN (?`,而且欄名可以帶表別名(`rp.user_email`)。
 * 認不出來就回 null —— 這支寧可漏,不要誤報。
 */
export function columnBefore(sqlUpToPlaceholder: string): string | null {
	const tail = sqlUpToPlaceholder.replace(/\s+/g, " ");
	const m = tail.match(/(?:[A-Za-z_][\w]*\.)?([A-Za-z_][\w]*)\s*(?:=|IN\s*\()\s*$/);
	return m ? m[1] : null;
}

/**
 * 掃一份 worker 原始碼,找出「欄名幾乎決定了該綁什麼,但綁的不是那個」的地方。
 *
 * 刻意跳過的情況(全都會產生誤報,而且它們本來就不是這支要管的):
 *   - `.bind(...arr)` 展開 —— 引數是算出來的,對不上任何位置
 *   - 引數裡還有 `prepare(` —— 那是 `.batch([...])` 裡的另一句,不是這一句的引數
 *   - `?` 的數量跟引數數量對不上 —— 那是另一種錯,交給執行期的 D1 去喊
 */
export function findBindOrderIssues(source: string): BindIssue[] {
	const issues: BindIssue[] = [];
	// ⚠️ `)` 與 `.bind(` 之間**必須容得下註解** —— 而且這正是一個實際踩到的坑:
	// 這支寫好之後,我在那個位置加了一段說明為什麼順序是這樣,結果整個 exam.ts
	// 就被跳過了,而測試照樣全綠。守衛靜靜漏掉它要守的那一行,比沒有守衛更糟。
	// GAP 因此吃「空白 + 行註解 + 區塊註解」的任意組合,並且有一條測試釘著。
	const GAP = String.raw`(?:\s|//[^\n]*|/\*[\s\S]*?\*/)*`;
	const re = new RegExp(
		String.raw`\.prepare\(` +
			GAP +
			String.raw`(\`[^\`]*\`|"[^"]*"|'[^']*')` +
			GAP +
			String.raw`,?` +
			GAP +
			String.raw`\)` +
			GAP +
			String.raw`\.?` +
			GAP +
			String.raw`bind\(([^()]*(?:\([^()]*\)[^()]*)*)\)`,
		"g",
	);
	let m: RegExpExecArray | null;
	while ((m = re.exec(source))) {
		const sql = m[1].slice(1, -1);
		const argsSrc = m[2];
		if (argsSrc.includes("...") || argsSrc.includes("prepare(")) continue;
		const args = splitArgs(argsSrc);
		const marks = [...sql.matchAll(/\?/g)];
		if (marks.length !== args.length) continue;

		const line = source.slice(0, m.index).split("\n").length;
		marks.forEach((mark, i) => {
			const col = columnBefore(sql.slice(0, mark.index));
			if (!col) return;
			const rule = EXPECTED.find((e) => e.column === col);
			if (!rule) return;
			const bound = args[i];
			const ok = rule.wants.some((w) =>
				bound.toLowerCase().includes(w.toLowerCase()),
			);
			if (!ok)
				issues.push({ index: i + 1, column: col, bound, line });
		});
	}
	return issues;
}

/** 給測試印出來看的一行。 */
export function formatIssue(file: string, i: BindIssue): string {
	return `${file}:${i.line} 第 ${i.index} 個 ? 是 \`${i.column} = ?\`,但綁的是 \`${i.bound}\``;
}

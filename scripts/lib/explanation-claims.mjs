// 從共筆詳解的純文字裡認出「這篇宣稱的選項」。
// 只收已經穩定的句型。認不出來、或同時宣稱兩個選項，都進未解析，不猜。
// 這支不做任何寫入。

const LETTER = "[A-Ea-eＡ-Ｅａ-ｅ]";

// 句型只負責切出字母。字母算不算「宣稱的選項」由 boundaryOk 決定，
// 不寫進正則的尾端：可選的右括號會回溯，把「答案(C)錯誤」救成命中。
const PATTERNS = [
	new RegExp(`正解\\s*[:：為是]?\\s*[（(]?\\s*(${LETTER})`, "g"),
	new RegExp(`答案是\\s*[（(]?\\s*(${LETTER})`, "g"),
	new RegExp(`答案為\\s*[（(]?\\s*(${LETTER})`, "g"),
	new RegExp(`正確答案\\s*[:：為是]?\\s*[（(]?\\s*(${LETTER})`, "g"),
	new RegExp(`故選(?!項)\\s*[:：為]?\\s*[（(]?\\s*(${LETTER})`, "g"),
	new RegExp(`答案\\s*[:：]\\s*[（(]?\\s*(${LETTER})`, "g"),
	// 「答案C。」「故答案A。」「正確答案為 X」已由上面的句型吃掉；
	// 排除緊貼在「正／是／為」後面的「答案」，避免同一句被算兩次。
	new RegExp(`(?<![正是為])答案\\s*[（(]?\\s*(${LETTER})`, "g"),
];

// 「正確答案為 CD71」的 C 後面還有英數，不是選項。
// 「答案(C)錯誤」先吃掉右括號，再看到否定詞，也不算宣稱 C。
function boundaryOk(text, index) {
	let i = index;
	const ch = text[i];
	if (ch === ")" || ch === "）") i += 1;
	const rest = text.slice(i);
	if (/^[A-Za-z0-9]/.test(rest)) return false;
	if (/^\s*(?:錯誤|不正確|不對|為非)/.test(rest)) return false;
	return true;
}

const FULLWIDTH = {
	Ａ: "A",
	Ｂ: "B",
	Ｃ: "C",
	Ｄ: "D",
	Ｅ: "E",
	ａ: "A",
	ｂ: "B",
	ｃ: "C",
	ｄ: "D",
	ｅ: "E",
};

export function normalizeLetter(ch) {
	if (typeof ch !== "string" || ch.length === 0) return null;
	const mapped = FULLWIDTH[ch] ?? ch.toUpperCase();
	return /^[A-E]$/.test(mapped) ? mapped : null;
}

/** 題庫欄位。單一字母才正規化，其他原樣留下，好跟宣稱的字母比得出差異。 */
export function normalizeField(answer) {
	const raw = String(answer ?? "").trim();
	const letter = normalizeLetter(raw);
	return letter ?? raw;
}

export function textFromDoc(doc) {
	const out = [];
	const walk = (n) => {
		if (!n || typeof n !== "object") return;
		if (typeof n.text === "string") out.push(n.text);
		const kids = Array.isArray(n) ? n : n.content;
		if (Array.isArray(kids)) for (const kid of kids) walk(kid);
	};
	try {
		walk(doc);
	} catch {
		return "";
	}
	return out.join(" ");
}

export function explanationText(content) {
	if (content == null || content === "") return "";
	if (typeof content === "object") return textFromDoc(content);
	if (typeof content !== "string") return "";
	try {
		const doc = JSON.parse(content);
		if (doc && typeof doc === "object") return textFromDoc(doc);
	} catch {
		// 不是 TipTap JSON 就當純文字掃。
	}
	return content;
}

/** @returns {string[]} 穩定句型宣稱過的選項，去重後按字母排。 */
export function claimedLetters(text) {
	const found = new Set();
	const src = String(text ?? "");
	for (const re of PATTERNS) {
		re.lastIndex = 0;
		for (const m of src.matchAll(re)) {
			const at = m.index + m[0].length;
			if (!boundaryOk(src, at)) continue;
			const letter = normalizeLetter(m[1]);
			if (letter) found.add(letter);
		}
	}
	return [...found].sort();
}

/**
 * @param {{ id: string, answer: unknown, text: string, hasHistory?: boolean }} row
 */
export function classifyExplanation(row) {
	const answer = normalizeField(row.answer);
	const base = {
		id: row.id,
		answer,
		hasHistory: !!row.hasHistory,
	};
	const text = String(row.text ?? "");
	if (!text.trim()) return { ...base, kind: "skipped" };
	const letters = claimedLetters(text);
	if (letters.length === 0) {
		return { ...base, kind: "unparsed", reason: "none", letters };
	}
	if (letters.length > 1) {
		return { ...base, kind: "unparsed", reason: "many", letters };
	}
	const claimed = letters[0];
	if (claimed === answer) return { ...base, kind: "agree", claimed };
	return { ...base, kind: "conflict", claimed };
}

export const CONFLICT_SQL = `SELECT q.id, q.answer, q.year, q.number,
       e.content_json AS content_json,
       EXISTS(SELECT 1 FROM answer_history h WHERE h.question_id = q.id) AS has_history
FROM questions q
LEFT JOIN explanations e ON e.question_id = q.id
ORDER BY q.year, q.number, q.id`;

/** 只允許一支 SELECT。寫入動詞出現就拒絕，不管它在註解還是字串裡。 */
export function assertReadOnlySql(sql) {
	const body = String(sql);
	if (!/^\s*SELECT\b/i.test(body)) {
		throw new Error("只讀腳本只允許 SELECT");
	}
	if (/\b(INSERT|UPDATE|DELETE|DROP|ALTER|REPLACE|CREATE)\b/i.test(body)) {
		throw new Error("只讀腳本裡出現了寫入語句");
	}
}

export function formatReport(items) {
	const conflicts = items.filter((i) => i.kind === "conflict");
	const unparsed = items.filter((i) => i.kind === "unparsed");
	const agree = items.filter((i) => i.kind === "agree");
	const skipped = items.filter((i) => i.kind === "skipped");
	const lines = [`衝突 ${conflicts.length}`];
	for (const c of conflicts) {
		lines.push(
			`${c.id}\t欄位 ${c.answer}\t詳解 ${c.claimed}\t${c.hasHistory ? "有答案紀錄" : "無答案紀錄"}`,
		);
	}
	lines.push("");
	lines.push(`未解析 ${unparsed.length}`);
	for (const u of unparsed) {
		const why =
			u.reason === "many"
				? `宣稱了不只一個選項：${u.letters.join("、")}`
				: "沒有可辨認的答案句";
		lines.push(`${u.id}\t${why}`);
	}
	lines.push("");
	lines.push(`一致 ${agree.length}`);
	lines.push(`沒有詳解 ${skipped.length}`);
	return lines.join("\n");
}

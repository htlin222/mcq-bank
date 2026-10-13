// 既有題庫裡，哪些選項會被匯入閘門當成「字母或括號中段被截斷」。
// 規則就是 worker/lib/option-truncation.ts，跟 CSV preflight、發行閘門同一支。
// 這支只讀。修題走 #84（來源 JSON 與 D1 一起改），不要在這裡 UPDATE。

import { optionCut } from "../../worker/lib/option-truncation.ts";
import { assertReadOnlySql } from "./explanation-claims.mjs";

export const LIST_SQL = `SELECT id, options_json
FROM questions
ORDER BY year, number, id`;

const LABEL = { paren: "括號中段", letter: "字母中段" };

export function parseOptions(raw) {
	let value = raw;
	if (typeof raw === "string") {
		if (!raw.trim()) return [];
		value = JSON.parse(raw);
	}
	if (Array.isArray(value)) {
		return value
			.filter((o) => o && typeof o.text === "string")
			.map((o) => [String(o.key ?? ""), o.text]);
	}
	if (value && typeof value === "object") {
		return Object.entries(value).filter(([, text]) => typeof text === "string");
	}
	return [];
}

export function cutsInRow(row) {
	const hits = [];
	for (const [key, text] of parseOptions(row.options_json)) {
		const kind = optionCut(text);
		if (!kind) continue;
		hits.push({ id: String(row.id), key, kind, text });
	}
	return hits;
}

export function formatReport(hits) {
	const lines = [
		`截斷 ${hits.length}`,
		"同一條規則也用在 CSV 整批拒絕與發行閘門。這份清單只讀，不 UPDATE。修已上線的列走 #84。",
	];
	for (const hit of hits) {
		const tail = hit.text.trim().slice(-48);
		lines.push(`${hit.id}\t${hit.key}\t${LABEL[hit.kind]}\t${tail}`);
	}
	return lines.join("\n");
}

export function assertListSql() {
	assertReadOnlySql(LIST_SQL);
}

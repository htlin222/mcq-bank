// 長名不能直接當判定字串。清單從 dx.json 算出來,不手抄 id。
// 數量變成 0 時這支要紅,並講明鎖該拆掉 —— 不能靜靜變綠。
// 交卷前的 session / 作答回應裡出現 canonical_long 這個欄位也要紅。
// finish、gallery、診斷頁可以帶長名,不在這份掃描裡。

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { gradeSmear, type AcceptedTerm } from "./smear-grade.ts";
import { pickCorrectOptionLabel, type DxTermLike } from "./smear-mcq.ts";

type DxSeed = {
	dx_id: string;
	canonical_long: string;
	terms: DxTermLike[];
};

const PRE_SUBMIT = [
	"POST /sessions",
	"GET /sessions/:id",
	"POST /sessions/:id/answer",
	"POST /sessions/:id/mc-options",
	"POST /sessions/:id/initial",
];

function loadDxSeed(): DxSeed[] {
	const p = path.resolve(process.cwd(), "scripts/smear/data/dx.json");
	return JSON.parse(fs.readFileSync(p, "utf8"));
}

/** 把 canonical_long 原樣送進 gradeSmear,判定是 miss 的診斷。 */
export function longNameMisses(dxList: DxSeed[]) {
	return dxList.filter((dx) => {
		const grade = gradeSmear([dx.canonical_long], dx.terms as AcceptedTerm[]);
		return grade.tier === "miss";
	});
}

export function stripCommentsAndStrings(src: string): string {
	let out = "";
	let i = 0;
	while (i < src.length) {
		if (src.startsWith("//", i)) {
			const nl = src.indexOf("\n", i);
			i = nl < 0 ? src.length : nl;
			continue;
		}
		if (src.startsWith("/*", i)) {
			const end = src.indexOf("*/", i + 2);
			i = end < 0 ? src.length : end + 2;
			continue;
		}
		const q = src[i];
		if (q === "'" || q === '"' || q === "`") {
			i += 1;
			while (i < src.length) {
				if (src[i] === "\\") {
					i += 2;
					continue;
				}
				if (src[i] === q) {
					i += 1;
					break;
				}
				i += 1;
			}
			out += '""';
			continue;
		}
		out += src[i];
		i += 1;
	}
	return out;
}

export function slicePreSubmitHandlers(src: string): { name: string; body: string }[] {
	const re = /smearRoutes\.(get|post|put|delete)\(\s*"([^"]+)"/g;
	const marks = [...src.matchAll(re)].map((m) => ({
		name: `${m[1].toUpperCase()} ${m[2]}`,
		index: m.index ?? 0,
	}));
	const out: { name: string; body: string }[] = [];
	for (let i = 0; i < marks.length; i++) {
		const mark = marks[i];
		if (!PRE_SUBMIT.includes(mark.name)) continue;
		const end = marks[i + 1]?.index ?? src.length;
		out.push({ name: mark.name, body: src.slice(mark.index, end) });
	}
	return out;
}

/**
 * 回應物件裡的 canonical_long 欄位。SQL、型別標註、.canonical_long 讀取都不算。
 * 型別標註的值只會是 string / number / boolean(可帶 | null)。
 */
export function canonicalLongPayloadHits(handlerSrc: string): string[] {
	const code = stripCommentsAndStrings(handlerSrc);
	const hits: string[] = [];
	const keyRe = /(?<![\w.])canonical_long\s*\??\s*:\s*([^\n,;}]+)/g;
	for (const m of code.matchAll(keyRe)) {
		const value = m[1].trim().replace(/[;]\s*$/, "");
		if (/^(?:string|number|boolean)(?:\s*\|\s*(?:string|number|boolean|null))*\s*$/.test(value)) {
			continue;
		}
		hits.push(m[0].trim());
	}
	const shortRe = /(?<![\w.])canonical_long\s*(?=[,}])/g;
	for (const m of code.matchAll(shortRe)) hits.push(m[0].trim());
	return hits;
}

test("長名直接送進判定會 miss 的診斷,顯示用詞仍要判成 full", () => {
	const dxList = loadDxSeed();
	assert.ok(dxList.length >= 100, "種子資料筆數太少,可能讀錯檔案");
	const misses = longNameMisses(dxList);
	assert.ok(
		misses.length > 0,
		"長名已經都能被 gradeSmear 認成 full。這道鎖是在守「不能直接拿 canonical_long 當判定字串」。數量變 0 代表資料修好了,要改這支測試的說明,不能讓它靜靜變綠。",
	);
	const bad: string[] = [];
	for (const dx of misses) {
		const again = gradeSmear([dx.canonical_long], dx.terms as AcceptedTerm[]);
		if (again.tier !== "miss") bad.push(`${dx.dx_id} 長名不是 miss`);
		const label = pickCorrectOptionLabel(dx.terms, dx.canonical_long);
		if (label === dx.canonical_long) {
			bad.push(`${dx.dx_id} 沒有可判定的 full 詞,顯示字退回了長名`);
		}
		const graded = gradeSmear([label], dx.terms as AcceptedTerm[]);
		if (graded.tier !== "full") {
			bad.push(`${dx.dx_id} 顯示字 "${label}" 判成 ${graded.tier}`);
		}
	}
	assert.deepEqual(bad, []);
});

test("交卷前的 session 與作答回應不帶 canonical_long 欄位", () => {
	const src = fs.readFileSync(
		path.resolve(process.cwd(), "worker/routes/smear.ts"),
		"utf8",
	);
	const handlers = slicePreSubmitHandlers(src);
	assert.deepEqual(
		handlers.map((h) => h.name),
		PRE_SUBMIT,
		"掃不到交卷前的路由,這支測試會變空的綠燈",
	);
	const hits = handlers.flatMap((h) =>
		canonicalLongPayloadHits(h.body).map((hit) => `${h.name}: ${hit}`),
	);
	assert.deepEqual(hits, []);
});

test("作答回應裡寫進 canonical_long 時掃描要紅", () => {
	const sample = `
		smearRoutes.post("/sessions/:id/answer", async (c) => {
			const q: { canonical_long: string } = { canonical_long: "x" };
			const grade = gradeSmear(boxes, terms, q.canonical_long);
			return c.json({ ok: true, canonical_long: q.canonical_long });
		});
	`;
	const handlers = slicePreSubmitHandlers(sample);
	assert.equal(handlers.length, 1);
	const hits = canonicalLongPayloadHits(handlers[0].body);
	assert.deepEqual(hits, [
		'canonical_long: ""',
		"canonical_long: q.canonical_long",
	]);
});

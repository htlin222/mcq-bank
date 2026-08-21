import assert from "node:assert/strict";
import { test } from "node:test";
import {
	BULLETS,
	CRUMB_SEP,
	type Block,
	type Measure,
	fitCrumbs,
	formatStamp,
	layoutBlocks,
	layoutLines,
	pickFontSize,
	SIZE_LADDER,
	cardSourceLabel,
} from "./cardLayout.ts";

// 假量測器:CJK 與全形標點算 1 個字寬,其餘算半個。真實字型的比例不是這樣,
// 但斷行的**規則**與字型無關 —— 測試要驗的是規則,不是 Inter 的字距。
const measure: Measure = (text, size) => {
	let w = 0;
	for (const ch of text) w += /[⺀-鿿＀-｠“”‘’…›]/.test(ch) ? size : size / 2;
	return w;
};

const line = (n: number, size = 10) => n * size; // n 個全形字的寬度

test("layoutLines 逐字斷 CJK,但不切開拉丁詞", () => {
	const out = layoutLines("血液 haptoglobin 下降", line(6), 10, measure);
	assert.ok(
		out.every((l) => !/hapto\w*$/.test(l) || l.includes("haptoglobin")),
		`拉丁詞被切開了: ${JSON.stringify(out)}`,
	);
});

test("行首禁則:標點不落在行首", () => {
	// 寬度剛好會讓「。」被推到下一行
	for (let w = 3; w <= 12; w++) {
		const out = layoutLines("阿貝西低伊芙。傑克愛慕恩", line(w), 10, measure);
		for (const l of out) {
			assert.ok(!"。、，；：".includes(l[0]), `寬度 ${w} 時「${l[0]}」落在行首`);
		}
	}
});

test("行尾禁則:開括號不落在行尾", () => {
	for (let w = 3; w <= 12; w++) {
		const out = layoutLines("阿貝西低（伊芙傑克）愛慕", line(w), 10, measure);
		for (const l of out) {
			assert.ok(!"（「【".includes(l.slice(-1)), `寬度 ${w} 時「${l.slice(-1)}」落在行尾`);
		}
	}
});

test("禁則回退以單元為單位 —— 20% 不會被切成 2 / 0%", () => {
	// 這是原型抓到的真 bug:`%` 在行首禁則表裡,逐字回退會連拉兩次拆掉數字。
	for (let w = 4; w <= 20; w++) {
		const out = layoutLines("活性低於 10%（不是 20%），才符合", line(w), 10, measure);
		// 不變量是「單元不被切開」,不是「不以數字開頭」—— 整個 20% 一起換到
		// 下一行是**正確**的,那正是禁則回退該做的事。
		for (const unit of ["10%", "20%"]) {
			assert.ok(
				out.some((l) => l.includes(unit)),
				`寬度 ${w} 時 ${unit} 被切開:${JSON.stringify(out)}`,
			);
		}
		assert.ok(
			out.every((l) => l[0] !== "%"),
			`寬度 ${w} 時 % 落在行首:${JSON.stringify(out)}`,
		);
	}
});

test("layoutLines 保留原有的換行", () => {
	assert.deepEqual(layoutLines("上\n下", line(20), 10, measure), ["上", "下"]);
});

test("fitCrumbs 放得下就整條不動", () => {
	const c = ["甲", "乙", "丙"];
	assert.deepEqual(fitCrumbs(c, line(50), 10, measure), c);
});

test("fitCrumbs 從中段省略,頭尾都留著", () => {
	const c = ["第一層標題", "第二層標題", "第三層標題", "第四層標題"];
	const full = measure(c.join(CRUMB_SEP), 10, 600);
	const out = fitCrumbs(c, full - line(6), 10, measure);
	assert.equal(out[0], c[0], "第一段被丟了");
	assert.equal(out[out.length - 1], c[c.length - 1], "最後一段被丟了 —— 那是最具體的一節");
	assert.ok(out.includes("…"), `沒有省略記號: ${JSON.stringify(out)}`);
	assert.ok(out.length < c.length + 1, "沒有真的變短");
});

test("fitCrumbs 極窄時只留最後一段並截字", () => {
	const c = ["很長很長的第一層標題文字", "很長很長的最後一層標題文字"];
	const out = fitCrumbs(c, line(6), 10, measure);
	assert.equal(out.length, 1);
	assert.ok(out[0].endsWith("…"), `應該截字: ${JSON.stringify(out)}`);
	assert.ok(measure(out[0], 10, 600) <= line(6), "截完還是太寬");
	assert.ok(c[1].startsWith(out[0].slice(0, -1)), "留下的不是最後一段");
});

test("fitCrumbs 空輸入回空陣列,不丟例外", () => {
	assert.deepEqual(fitCrumbs([], line(10), 10, measure), []);
});

test("fitCrumbs 單段放不下時仍只回一段", () => {
	const out = fitCrumbs(["很長很長很長的唯一一層標題"], line(5), 10, measure);
	assert.equal(out.length, 1);
	assert.ok(measure(out[0], 10, 600) <= line(5));
});

const LI = (text: string, depth = 0, ordered = false, ordinal = 1): Block => ({
	kind: "li",
	depth,
	ordered,
	ordinal,
	text,
});

test("layoutBlocks 給清單掛號縮排:第二行對齊文字,不對齊符號", () => {
	const { rows } = layoutBlocks([LI("阿貝西低伊芙傑克愛慕恩歐皮")], {
		size: 10,
		textWidth: line(8),
		measure,
	});
	assert.ok(rows.length >= 2, "沒有換行,測不到掛號縮排");
	assert.equal(rows[0].marker, BULLETS[0]);
	assert.equal(rows[1].marker, null, "第二行不該再畫一次符號");
	assert.equal(rows[0].x, rows[1].x, "換行後沒有對齊文字欄");
	assert.ok(rows[0].x > rows[0].markerX, "文字沒有讓開符號的位置");
});

test("layoutBlocks 依深度換符號,並逐層縮排", () => {
	const { rows } = layoutBlocks([LI("甲", 0), LI("乙", 1), LI("丙", 2)], {
		size: 10,
		textWidth: line(20),
		measure,
	});
	assert.deepEqual(
		rows.map((r) => r.marker),
		BULLETS,
	);
	assert.ok(rows[0].markerX < rows[1].markerX && rows[1].markerX < rows[2].markerX);
});

test("layoutBlocks 的序號用傳進來的 ordinal,不重新從 1 數", () => {
	// 使用者只選了清單的後半段時,序號要跟他螢幕上看到的一致。
	const { rows } = layoutBlocks([LI("丙", 0, true, 3), LI("丁", 0, true, 4)], {
		size: 10,
		textWidth: line(20),
		measure,
	});
	assert.deepEqual(
		rows.map((r) => r.marker),
		["3.", "4."],
	);
});

test("layoutBlocks 清單項之間比段落之間緊", () => {
	const two = (bs: Block[]) =>
		layoutBlocks(bs, { size: 10, textWidth: line(20), measure }).height;
	const listGap = two([LI("甲"), LI("乙")]);
	const paraGap = two([{ kind: "para", text: "甲" }, { kind: "para", text: "乙" }]);
	assert.ok(listGap < paraGap, `清單間距 ${listGap} 應小於段落間距 ${paraGap}`);
});

test("layoutBlocks 空輸入高度為 0", () => {
	assert.deepEqual(layoutBlocks([], { size: 10, textWidth: line(10), measure }), {
		rows: [],
		height: 0,
	});
});

test("pickFontSize 放得下就用最大字級", () => {
	const size = pickFontSize([{ kind: "para", text: "短" }], line(40), 10_000, measure);
	assert.equal(size, SIZE_LADDER[0]);
});

test("pickFontSize 逐級降,但不低於階梯下限", () => {
	const long: Block[] = [{ kind: "para", text: "字".repeat(4000) }];
	const size = pickFontSize(long, 400, 300, measure);
	assert.equal(
		size,
		SIZE_LADDER[SIZE_LADDER.length - 1],
		"到底之後應該停下來讓卡片變高,不是繼續縮字",
	);
});

test("pickFontSize 中等長度會降級但不降到底", () => {
	const mid: Block[] = [{ kind: "para", text: "字".repeat(60) }];
	const big = pickFontSize(mid, line(30), 10_000, measure);
	const small = pickFontSize(mid, line(30), 120, measure);
	assert.ok(small < big, "限制高度之後沒有降級");
});

test("formatStamp 補零到分鐘,不含秒", () => {
	assert.equal(formatStamp(new Date(2026, 7, 21, 9, 5)), "2026-08-21 09:05");
	assert.equal(formatStamp(new Date(2026, 11, 31, 23, 59)), "2026-12-31 23:59");
});

test("cardSourceLabel 從題號推年份與題號,不查 number 欄位", () => {
	assert.equal(cardSourceLabel("/q/114-032"), "民國 114 年 · 第 32 題");
	assert.equal(cardSourceLabel("/q/111-069"), "民國 111 年 · 第 69 題");
	// 前導零要去掉,但年份原樣保留
	assert.equal(cardSourceLabel("/q/104-001"), "民國 104 年 · 第 1 題");
});

test("cardSourceLabel 非題目頁退回頁面標題,沒有就留空", () => {
	assert.equal(cardSourceLabel("/lectures/heme-01", "血液形態學"), "血液形態學");
	assert.equal(cardSourceLabel("/profile"), "");
	assert.equal(cardSourceLabel("/q/", "備援"), "備援", "壞掉的題號不該被當成題目頁");
});

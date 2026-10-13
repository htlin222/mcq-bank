import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { linkSlides, linkSql, parseSlideLinkArgs } from "./slide-links.ts";

const opts = { rareAbbrDf: 1, rareTermDf: 1, topN: 6, minText: 20 };

test("沒有 --slug 就拒絕,而且不會描述成已寫入", () => {
	assert.throws(() => parseSlideLinkArgs([]), /--slug/);
	assert.throws(() => parseSlideLinkArgs(["--dry-run"]), /不會動到任何講義/);
	const parsed = parseSlideLinkArgs(["--slug=lecture-7", "--dry-run"]);
	assert.deepEqual(parsed, { slug: "lecture-7", dryRun: true, remote: false });
	assert.equal(parseSlideLinkArgs(["--slug=lecture-1", "--remote"]).remote, true);
});

test("稀有詞才成連結:只共用 ALL 的題目不進來,ETP 會", () => {
	const questions = [
		{ id: "q-all", stem: "acute lymphoblastic leukemia", tags: ["ALL"] },
		{
			id: "q-etp",
			stem: "Early T-cell precursor (ETP) acute lymphoblastic leukemia",
			tags: ["ALL", "ETP"],
		},
		{ id: "q-aml", stem: "AML induction with cytarabine", tags: ["AML"] },
	];
	const page =
		"Early T-cell Precursor (ETP) ALL. All four criteria need to meet for the diagnosis of this leukemia.";
	const report = linkSlides([{ page: 24, text: page }], questions, opts);
	assert.deepEqual(
		report.links.map((l) => l.question_id),
		["q-etp"],
	);
	assert.equal(report.links[0].rank, 0);
	assert.equal(report.links[0].score, 1);
	assert.equal(report.linkedPages, 1);
	assert.equal(report.emptyPages, 0);
});

test("單獨一個短標籤不夠;題幹括號定義過的縮寫夠", () => {
	const questions = [
		{ id: "q-alk", stem: "Anaplastic large cell lymphoma", tags: ["ALK", "ALCL"] },
		{ id: "q-etp", stem: "Early T-cell precursor (ETP) leukemia", tags: ["ALL"] },
	];
	const rare = { rareAbbrDf: 5, rareTermDf: 5, topN: 6, minText: 20 };
	const nb = linkSlides(
		[
			{
				page: 71,
				text: "Neuroblastoma gene ALK and PHOX2B. Urinary catecholamines are elevated in this tumor.",
			},
		],
		questions,
		rare,
	);
	assert.deepEqual(nb.links, []);
	assert.equal(nb.emptyPages, 1);
	const both = linkSlides(
		[
			{
				page: 40,
				text: "ALCL is driven by ALK. This slide covers the lymphoma and the fusion.",
			},
		],
		questions,
		rare,
	);
	assert.deepEqual(
		both.links.map((l) => l.question_id),
		["q-alk"],
	);
	const etp = linkSlides(
		[
			{
				page: 24,
				text: "Early T-cell Precursor (ETP) ALL criteria are listed on this slide for the class.",
			},
		],
		questions,
		rare,
	);
	assert.deepEqual(
		etp.links.map((l) => l.question_id),
		["q-etp"],
	);
});

test("貧血這個泛詞單獨出現不會掛上題", () => {
	const report = linkSlides(
		[
			{
				page: 72,
				text: "Metastatic neuroblastoma with normochromic anemia and bone pain in a child today.",
			},
		],
		[{ id: "q-rpi", stem: "correcting the reticulocyte count for anemia", tags: ["anemia", "RPI"] }],
		{ rareAbbrDf: 5, rareTermDf: 5, topN: 6, minText: 20 },
	);
	assert.deepEqual(report.links, []);
	assert.equal(report.emptyPages, 1);
});

test("題庫沒有的主題是 0 筆,函式照樣回完", () => {
	const questions = [
		{ id: "q-all", stem: "acute lymphoblastic leukemia ALL", tags: ["ALL"] },
	];
	const text =
		"Neuroblastoma primary site neural crest. Gene PHOX2B, ALK. Urinary catecholamines. Horner syndrome.";
	const report = linkSlides([{ page: 71, text }], questions, opts);
	assert.deepEqual(report.links, []);
	assert.equal(report.emptyPages, 1);
	assert.equal(report.pages, 1);
});

test("過短的頁不算「沒對上」,中文病名從題幹骨架裡拆得出來", () => {
	const questions = [
		{
			id: "q-aml",
			stem: "下列有關急性骨髓性白血病(AML)的敘述何者錯誤?",
			tags: ["AML"],
		},
	];
	const report = linkSlides(
		[
			{ page: 1, text: "標題" },
			{ page: 8, text: "這一頁在教急性骨髓性白血病的誘導治療與支持療法,請對照指引。" },
		],
		questions,
		opts,
	);
	assert.equal(report.shortPages, 1);
	assert.equal(report.emptyPages, 0);
	assert.deepEqual(
		report.links.map((l) => l.question_id),
		["q-aml"],
	);
});

test("一頁最多 6 題,SQL 只刪指定的 slug", () => {
	const questions = Array.from({ length: 8 }, (_, i) => ({
		id: `q-${i}`,
		stem: `Disease marker MARKER number ${i} in the stem`,
		tags: ["MARKER"],
	}));
	const text = "This slide discusses MARKER in detail and how the marker presents.";
	const report = linkSlides([{ page: 3, text }], questions, {
		rareAbbrDf: 10,
		rareTermDf: 10,
		topN: 6,
		minText: 20,
	});
	assert.equal(report.links.length, 6);
	assert.deepEqual(
		report.links.map((l) => l.rank),
		[0, 1, 2, 3, 4, 5],
	);
	const sql = linkSql("lecture-7", report.links, 1);
	assert.match(sql, /DELETE FROM lecture_page_questions WHERE slug = 'lecture-7';/);
	assert.equal(sql.includes("lecture-1"), false);
	assert.equal((sql.match(/INSERT INTO/g) ?? []).length, 6);
	const empty = linkSql("lecture-7", [], 1);
	assert.match(empty, /^DELETE FROM lecture_page_questions WHERE slug = 'lecture-7';\n$/);
	assert.equal(empty.includes("INSERT"), false);
	const quoted = linkSql("it's", [], 1);
	assert.match(quoted, /slug = 'it''s'/);
});

test("腳本本體不呼叫 Workers AI", () => {
	const src = readFileSync("scripts/build-slide-mcq-links.ts", "utf8");
	assert.equal(/api\.cloudflare\.com|ai\/run|EMBED_MODEL|TEXT_MODEL/.test(src), false);
	assert.match(src, /wrote/);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { assertReadOnlySql } from "./explanation-claims.mjs";
import {
	LIST_SQL,
	assertListSql,
	cutsInRow,
	formatReport,
	parseOptions,
} from "./option-cut-report.mjs";

test("清單 SQL 是單一支 SELECT", () => {
	assert.doesNotThrow(() => assertListSql());
	assert.match(LIST_SQL, /^SELECT\b/);
	assert.throws(() => assertReadOnlySql("UPDATE questions SET stem = stem"));
	assert.throws(() =>
		assertReadOnlySql(`${LIST_SQL}; UPDATE questions SET stem = stem`),
	);
});

test("截斷的選項進清單，正常結尾不進", () => {
	const hits = cutsInRow({
		id: "104-012",
		options_json: JSON.stringify([
			{ key: "A", text: "Burkitt lymphoma" },
			{ key: "C", text: "Lymphomatoid granulomatosis (" },
			{ key: "E", text: "etc." },
		]),
	});
	assert.deepEqual(
		hits.map((h) => [h.key, h.kind]),
		[["C", "paren"]],
	);
	const report = formatReport(hits);
	assert.match(report, /^截斷 1/);
	assert.match(report, /不 UPDATE/);
	assert.match(report, /104-012\tC\t括號中段\tLymphomatoid granulomatosis \(/);
	assert.equal(
		cutsInRow({
			id: "114-001",
			options_json: { A: "studies", B: "kappa-", C: "CD15-", D: "follow-up" },
		}).length,
		0,
	);
});

test("兩種 options 形狀都讀得到", () => {
	assert.deepEqual(parseOptions('[{"key":"A","text":"x"}]'), [["A", "x"]]);
	assert.deepEqual(parseOptions({ B: "y" }), [["B", "y"]]);
	assert.deepEqual(parseOptions(""), []);
	assert.deepEqual(parseOptions(null), []);
});

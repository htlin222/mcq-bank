import { test } from "node:test";
import assert from "node:assert/strict";
import {
	DEFAULT_WRONG_SORT,
	WRONG_SORTS,
	isWrongSort,
	wrongOrderBy,
} from "./wrong-sort.ts";

test("未知 / 空值退回預設,不丟例外", () => {
	const d = wrongOrderBy(DEFAULT_WRONG_SORT);
	for (const v of [undefined, null, "", "bogus", "rate; DROP TABLE questions"]) {
		assert.equal(wrongOrderBy(v as any), d);
	}
});

test("每一種排序都有對應的片段,而且互不相同", () => {
	const seen = new Set(WRONG_SORTS.map((s) => wrongOrderBy(s)));
	assert.equal(seen.size, WRONG_SORTS.length, "有兩種排序產生同一段 ORDER BY");
});

test("一律以 q.id 收尾 —— 同分要有全序,否則清單每次重整就換位置", () => {
	for (const s of WRONG_SORTS) {
		assert.match(wrongOrderBy(s), /q\.id$/, `${s} 沒有全序的收尾`);
	}
});

test("片段裡不會出現呼叫端傳進來的字 —— 是查表不是拼字串", () => {
	const evil = "1; DELETE FROM review_progress";
	assert.ok(!wrongOrderBy(evil).includes("DELETE"));
	assert.ok(!wrongOrderBy(evil).includes(evil));
});

test("isWrongSort 只認清單裡的值", () => {
	assert.ok(isWrongSort("rate"));
	assert.ok(isWrongSort("number"));
	assert.ok(!isWrongSort("RATE"));
	assert.ok(!isWrongSort(1));
	assert.ok(!isWrongSort(undefined));
});

test("預設是錯誤率 —— 舊行為不能因為加了下拉就悄悄換掉", () => {
	assert.equal(DEFAULT_WRONG_SORT, "rate");
	assert.match(wrongOrderBy(undefined), /times_correct \* 100 \/ rp\.times_seen\) ASC/);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { ftsQuery } from "./fts-query.ts";

// ⚠️ 搜尋語法壞掉的時候**不會報錯,只會少給結果** —— 使用者看到的是「怎麼找不到」,
// 而那句話對不到任何一行程式。所以這一支釘得比一般的純函式細。

test("沒有逗號時輸出跟以前完全一樣 —— 這個功能不該動到既有查詢", () => {
	assert.equal(ftsQuery("AML"), "AML*");
	assert.equal(ftsQuery("AML M3"), "AML* M3*");
});

test("逗號 = OR,每一段各自加括號", () => {
	assert.equal(ftsQuery("AML, CML"), "(AML*) OR (CML*)");
});

test("**全形逗號也算**", () => {
	// 中文輸入法預設打出來的就是全形。只認半形等於在中文使用者身上完全不生效,
	// 而他們正是最會用這個功能的人。
	assert.equal(ftsQuery("AML，CML"), "(AML*) OR (CML*)");
	assert.equal(ftsQuery("AML, CML，APL"), "(AML*) OR (CML*) OR (APL*)");
});

test("一段之內的空白仍然是 AND", () => {
	// 「(AML 且 M3) 或 CML」—— 那是讀起來最自然的一種。
	assert.equal(ftsQuery("AML M3, CML"), "(AML* M3*) OR (CML*)");
});

test("空白段落整段丟掉,不會產生空的括號", () => {
	// 空的括號會讓 FTS5 直接丟語法錯誤 —— 而路由把那個變成 400,
	// 使用者只會看到「搜尋失敗」。
	assert.equal(ftsQuery("AML,"), "AML*");
	assert.equal(ftsQuery(",AML"), "AML*");
	assert.equal(ftsQuery("AML,,CML"), "(AML*) OR (CML*)");
	assert.equal(ftsQuery("AML, , CML"), "(AML*) OR (CML*)");
});

test("整串只有逗號與空白時回空字串 —— 呼叫端要靠它跳過 MATCH", () => {
	assert.equal(ftsQuery(""), "");
	assert.equal(ftsQuery("  "), "");
	assert.equal(ftsQuery(",,"), "");
	assert.equal(ftsQuery("，"), "");
	// 引號會被換成空白,所以整串引號等於什麼都沒輸入。
	assert.equal(ftsQuery('"""'), "");
});

test("落單的引號換成空白,不會把我們自己的引號配對打斷", () => {
	assert.equal(ftsQuery('AML"'), "AML*");
	assert.equal(ftsQuery('"白血病"'), '"白血病"*');
});

test("**不做 toLowerCase()**", () => {
	// FTS5 的 unicode61 對索引與查詢兩側都 case fold,所以大小寫本來就等價
	// (實測 `aml*` 與 `AML*` 命中同一列)。而 AND / OR / NOT **只有大寫才是
	// 運算子** —— 在這裡壓成小寫會把一個現有的功能靜靜弄壞。
	assert.equal(ftsQuery("aml"), "aml*");
});

test("大寫的 AND / OR / NOT 原樣通過 —— 加了 * 會是語法錯誤", () => {
	// 舊版把它們也加上 `*`,於是 `AML OR CML` → `AML* OR* CML*`,而那是
	// **FTS5 語法錯誤**(實測 `fts5: syntax error near "*"`)—— 路由把它變成
	// 400,使用者看到「搜尋失敗」。註解上寫著支援的功能其實一直是壞的。
	assert.equal(ftsQuery("AML OR CML"), "AML* OR CML*");
	assert.equal(ftsQuery("AML NOT chronic"), "AML* NOT chronic*");
	// 小寫的 or 是一般的詞,不是運算子 —— 那是 FTS5 自己的規矩。
	assert.equal(ftsQuery("AML or CML"), "AML* or* CML*");
});

test("CJK 包成片語再加前綴 *", () => {
	// ⚠️ 這只救得到「從一段 CJK 的開頭算起」的比對:unicode61 把連續 CJK 當成
	// **一個** token,所以「白血病」比不到「慢性骨髓性白血病」。那是 tokenizer
	// 的限制,不是這裡能修的。加 `*` 至少讓「慢性」比得到「慢性骨髓性白血病」——
	// 沒有 `*` 的話連那個都不行。
	assert.equal(ftsQuery("慢性"), '"慢性"*');
	assert.equal(ftsQuery("慢性, 急性"), '("慢性"*) OR ("急性"*)');
});

test("混合中英與底線", () => {
	assert.equal(ftsQuery("BCR_ABL1"), "BCR_ABL1*");
	assert.equal(ftsQuery("BCR::ABL1"), '"BCR::ABL1"*');
});

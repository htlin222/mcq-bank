import { test } from "node:test";
import assert from "node:assert/strict";
import {
	buildImportStatements,
	USER_TABLES,
	COMMUNITY_SOURCES,
	esc,
	termKey,
	sqlStr,
} from "./sql.ts";

// 一份最小但形狀完整的匯入輸入。每條測試各自改自己關心的那一塊。
function fixture() {
	return {
		now: 1_700_000_000_000,
		dx: [
			{
				dx_id: "dacrocyte",
				canonical_long: "dacrocyte",
				canonical_abbrev: null,
				topic: "rbc",
				qtype: "cell" as const,
			},
			{
				dx_id: "aml_m3",
				canonical_long: "acute promyelocytic leukemia",
				canonical_abbrev: "APL",
				topic: "myeloid",
				qtype: "disease" as const,
			},
		],
		terms: [
			{
				dx_id: "dacrocyte",
				text: "dacryocyte",
				norm: "dacryocyte",
				tier: "full" as const,
				form: "long" as const,
			},
			{
				dx_id: "dacrocyte",
				text: "tear drop",
				norm: "tear drop",
				tier: "lay" as const,
				form: "long" as const,
			},
		],
		questions: [
			{
				id: "exam-t3-018",
				dx_id: "dacrocyte",
				source: "exam",
				source_ref: "Test-3 p18",
				source_url: null,
				attribution: null,
				image_key_view: "smear/t3-018-view.webp",
				image_key_full: "smear/t3-018-full.webp",
				prompt: "What cell?",
				image_note: null,
			},
		],
		notes: [
			{
				dx_id: "dacrocyte",
				content_json: { type: "doc", content: [] },
				related_dx_ids: ["aml_m3"],
			},
		],
	};
}

const sql = (o = {}) => buildImportStatements({ ...fixture(), ...o }).join("\n");

// ────────────────────────────────────────────────────────────────
// 這一節是整支重寫的理由:匯入只准動內容,不准動使用者寫下的東西。
// ────────────────────────────────────────────────────────────────

test("使用者的表一個字都不准出現在匯入 SQL 裡", () => {
	// 舊版 DELETE FROM smear_dx 會沿 ON DELETE CASCADE 把 smear_notes /
	// smear_comments / smear_dx_bookmarks 一起帶走 —— 那三張表 0044 才加,
	// 而刪除清單是 0043 時代寫的,從來沒有人回去補。所以這裡不是檢查
	// 「有沒有 DELETE 那三張表」,是檢查那些名字**完全不出現** ——
	// 只要提到了,就得回來想一次它會不會被連帶動到。
	const out = sql({ prune: true }); // prune 是最寬鬆的模式,連它都不准碰
	for (const t of USER_TABLES) {
		// smear_term_votes 允許出現在子查詢裡(避開有人投過票的詞條),
		// 但只能是 SELECT,不能是 DELETE/INSERT/UPDATE 的目標。
		const mutated = new RegExp(
			`(DELETE\\s+FROM|INSERT\\s+INTO|UPDATE)\\s+${t}\\b`,
			"i",
		);
		assert.equal(mutated.test(out), false, `${t} 被匯入改動了`);
	}
});

test("USER_TABLES 真的列出了每一張使用者表(對照組:漏一張這條就沒有意義)", () => {
	for (const t of [
		"smear_sessions",
		"smear_answers",
		"smear_term_votes",
		"smear_dx_bookmarks",
		"smear_notes",
		"smear_comments",
		"smear_submissions",
	]) {
		assert.ok(USER_TABLES.includes(t), `USER_TABLES 少了 ${t}`);
	}
});

test("內容表走 upsert,不是整張清空重灌", () => {
	const out = sql();
	for (const t of ["smear_dx", "smear_terms", "smear_questions", "smear_dx_notes"]) {
		assert.equal(
			new RegExp(`DELETE\\s+FROM\\s+${t}\\s*;`, "i").test(out),
			false,
			`${t} 仍然被整張清空`,
		);
		assert.match(out, new RegExp(`INSERT INTO ${t}[\\s\\S]*?ON CONFLICT`, "i"));
	}
});

// ────────────────────────────────────────────────────────────────
// 三種「社群寫進內容表」的東西,各自要有一道閘擋住覆寫
// ────────────────────────────────────────────────────────────────

test("社群提報通過的寫法不會被匯入蓋回去", () => {
	// smear_terms 的唯一鍵是 (dx_id, norm)。匯入的詞跟社群提報的詞可能同鍵,
	// 沒有這道閘的話:被否決的墓碑(rejected)會被翻回 accepted —— 那正是
	// 0043 留墓碑要防的「同一個詞被反覆提報」。
	assert.match(
		sql(),
		/INSERT INTO smear_terms[\s\S]*?ON CONFLICT\(dx_id, norm\) DO UPDATE[\s\S]*?WHERE smear_terms\.proposed_by IS NULL/i,
	);
});

test("核准的投稿題不會被匯入覆寫", () => {
	assert.match(
		sql(),
		/INSERT INTO smear_questions[\s\S]*?ON CONFLICT\(id\) DO UPDATE[\s\S]*?WHERE smear_questions\.source <> 'submission'/i,
	);
});

test("站上編輯過的共筆詳解不會被匯入蓋掉", () => {
	// 匯入寫的列 updated_by 是 NULL;有人在站上存過就會是 email。
	assert.match(
		sql(),
		/INSERT INTO smear_dx_notes[\s\S]*?ON CONFLICT\(dx_id\) DO UPDATE[\s\S]*?WHERE smear_dx_notes\.updated_by IS NULL/i,
	);
});

// ────────────────────────────────────────────────────────────────
// 過期內容:能不能刪,看它刪下去會不會連帶動到使用者資料
// ────────────────────────────────────────────────────────────────

test("預設不刪任何會連帶清掉使用者資料的內容列", () => {
	// smear_dx 一刪 → 筆記/討論/收藏跟著沒(CASCADE),而且被投稿引用時
	// 還會直接 FK 失敗。smear_questions 一刪 → 那題的作答歷史跟著沒。
	// 兩者都只在明講 --prune 時才做。
	const out = sql();
	assert.equal(/DELETE FROM smear_dx\b/i.test(out), false);
	assert.equal(/DELETE FROM smear_questions\b/i.test(out), false);
});

test("--prune 才刪過期的診斷與題目,而且只刪匯入自己的來源", () => {
	const out = sql({ prune: true });
	assert.match(out, /DELETE FROM smear_dx WHERE id NOT IN \('dacrocyte', 'aml_m3'\)/i);
	// 投稿題的 source 是社群來源,不能被當成「過期」掃掉。
	assert.ok(COMMUNITY_SOURCES.includes("submission"));
	const f = fixture();
	f.questions.push({ ...f.questions[0], id: "seed-subq", source: "submission" });
	const withSub = buildImportStatements({ ...f, prune: true }).join("\n");
	const del = withSub.split("DELETE FROM smear_questions")[1] ?? "";
	assert.equal(/'submission'/.test(del), false);
	assert.match(del, /source IN \('exam'\)/i);
});

test("過期的匯入詞條預設就清掉 —— 但避開有人投過票的", () => {
	// 這個不必等 --prune:留著一個拼錯的 alias,使用者寫錯字會被判成答對,
	// 那是判定錯誤不是資料陳舊。但要避開兩種列:社群提報的、以及有票的。
	const out = sql();
	assert.match(out, /DELETE FROM smear_terms WHERE[\s\S]*?proposed_by IS NULL/i);
	assert.match(out, /id NOT IN \(SELECT term_id FROM smear_term_votes\)/i);
});

// ────────────────────────────────────────────────────────────────
// FTS
// ────────────────────────────────────────────────────────────────

test("FTS 從資料庫重建,不是從匯入資料重建", () => {
	// 從匯入資料重建的話,社群提報通過的寫法跟站上編輯過的詳解都不會進索引
	// —— 搜尋找不到,而且無聲。改成 INSERT ... SELECT 之後,索引反映的是
	// 表裡實際有什麼,誰寫的都算。
	const out = sql();
	assert.match(out, /DELETE FROM smear_fts\s*;/i);
	assert.match(out, /INSERT INTO smear_fts[\s\S]*?SELECT[\s\S]*?FROM smear_dx/i);
	assert.match(out, /FROM smear_terms[\s\S]*?status = 'accepted'/i);
	// 詳解純文字用 json_tree 走出來(同 migration 0016 的慣用法),
	// 不是把整份 content_json 塞進索引。
	assert.match(out, /json_tree/i);
	// 而且不能有逐列寫死的 FTS INSERT VALUES —— 那就是「從匯入資料重建」。
	assert.equal(/INSERT INTO smear_fts[^;]*VALUES/i.test(out), false);
});

// ────────────────────────────────────────────────────────────────
// 順序與跳脫
// ────────────────────────────────────────────────────────────────

test("smear_dx 排在引用它的表之前(FK)", () => {
	const stmts = buildImportStatements(fixture());
	const at = (re: RegExp) => stmts.findIndex((s) => re.test(s));
	const dx = at(/INSERT INTO smear_dx\b/);
	assert.ok(dx >= 0);
	for (const re of [
		/INSERT INTO smear_terms\b/,
		/INSERT INTO smear_questions\b/,
		/INSERT INTO smear_dx_notes\b/,
	]) {
		assert.ok(at(re) > dx, `${re} 排在 smear_dx 之前`);
	}
});

test("單引號有跳脫(對照組:沒跳脫的話這段 SQL 會壞掉而不是寫錯資料)", () => {
	const f = fixture();
	f.dx[0].canonical_long = "Auer's rod";
	const out = buildImportStatements(f).join("\n");
	assert.match(out, /'Auer''s rod'/);
	assert.equal(esc("a'b"), "a''b");
	assert.equal(sqlStr(null), "NULL");
	assert.equal(sqlStr("a'b"), "'a''b'");
});

test("空的輸入不會產出半截 SQL", () => {
	const stmts = buildImportStatements({
		now: 1,
		dx: [],
		terms: [],
		questions: [],
		notes: [],
	});
	for (const s of stmts) assert.match(s, /;\s*$/);
	// 一筆 dx 都沒有時,--prune 不該產出 `NOT IN ()` 這種語法錯誤。
	const pruned = buildImportStatements({
		now: 1,
		dx: [],
		terms: [],
		questions: [],
		notes: [],
		prune: true,
	}).join("\n");
	assert.equal(/NOT IN \(\)/.test(pruned), false);
});

// ────────────────────────────────────────────────────────────────
// 以下六條都來自 /code-review high 的發現。每一條都是「重跑一次匯入」
// 這個本來就該安全的動作會壞掉的路徑 —— 而不重跑就看不到。
// ────────────────────────────────────────────────────────────────

test("詞條的 id 由 (dx_id, norm) 決定,不是陣列位置", () => {
	// 位置式 id(`${dx_id}-t${idx}`)在「改一個錯字」「插一個詞」之後,
	// 同一個 id 會配到不同的 norm:INSERT 撞的是 PRIMARY KEY,而 upsert 的
	// 衝突目標是 (dx_id, norm) —— 目標不同,SQLite 直接報錯而不是更新,
	// 整批匯入中斷。⚠️ 原樣重跑不會壞(兩個鍵指向同一列),所以手測看不到。
	assert.equal(termKey("dacrocyte", "dacryocyte"), "dacrocyte::dacryocyte");
	assert.notEqual(
		termKey("dacrocyte", "dacryocyte"),
		termKey("dacrocyte", "teardrop cell"),
	);
	// 產出的 SQL 真的用它當主鍵,不是還在用傳進來的 t.id
	assert.match(sql(), /INSERT INTO smear_terms[^;]*VALUES \('dacrocyte::dacryocyte'/);
});

test("dx_id 或 norm 帶了分隔符就整批拒絕,不靜默算出撞在一起的鍵", () => {
	// normalizeTerm() 把 ':' 換成空白、dx_id 是 [a-z0-9_] 的 slug,所以這個
	// 情況不該發生 —— 但真的發生時要當場停,不是算出一個有歧義的鍵然後
	// 用它去刪列。
	assert.throws(() => termKey("bad:id", "x"), /bad:id/);
	assert.throws(() => termKey("ok", "a:b"), /a:b/);
});

test("清過期詞條時,只掃這次匯入有的診斷", () => {
	// 沒有這個範圍限制的話:某個診斷從 dx.json 拿掉(而預設不 --prune,
	// 所以它的 smear_dx 與題目都還在),它的詞條卻會被全部清光 ——
	// gradeSmear() 只看 smear_terms,那幾題從此**每個答案都判 miss**,
	// 而畫面上沒有任何東西解釋得了。
	const out = sql();
	assert.match(out, /DELETE FROM smear_terms WHERE[\s\S]*?dx_id IN \('dacrocyte'\)/i);
	// 比對鍵要有真的分隔符,不是空字串接起來(`a`+`ll` 與 `al`+`l` 會撞)
	assert.match(out, /dx_id \|\| '::' \|\| norm/i);
	assert.equal(/\|\| '' \|\|/.test(out), false);
});

test("--prune 的來源清單來自這次真的產出的題目,不是寫死的", () => {
	// 寫死 ['exam','ash','po'] 的話,任何一筆 po 題目都會在第一次 --prune
	// 被刪掉 —— 因為匯入根本不產 po,它永遠不在保留名單裡。
	const out = sql({ prune: true });
	assert.match(out, /DELETE FROM smear_questions WHERE source IN \('exam'\)/i);
	assert.equal(/'po'/.test(out), false);
});

test("--prune 在沒有題目時不產出 `NOT IN ()`(SQLite 當它是真,整批刪光)", () => {
	const out = buildImportStatements({ ...fixture(), questions: [], prune: true }).join("\n");
	assert.equal(/DELETE FROM smear_questions/i.test(out), false);
	// 診斷那條照樣要在 —— 兩個刪除各看各的清單,不共用一個守衛
	assert.match(out, /DELETE FROM smear_dx WHERE/i);
});

test("FTS 的清空與重建是同一個陳述式單元,不會被切到兩個檔案", () => {
	// import.ts 把陳述式每 50 條切一個 .sql 檔分開送,而那一步實測會偶發
	// 失敗(所以才有 shRetry)。清空跟重建落在不同檔案、而後者重試三次都
	// 失敗的話,smear_fts 是空的 —— 搜尋從此什麼都找不到,無聲。
	const stmts = buildImportStatements(fixture());
	const unit = stmts.find((s) => /DELETE FROM smear_fts/i.test(s));
	assert.ok(unit, "找不到 FTS 清空");
	assert.match(unit, /INSERT INTO smear_fts[\s\S]*?SELECT/i);
});

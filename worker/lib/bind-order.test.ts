import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
	columnBefore,
	findBindOrderIssues,
	formatIssue,
	splitArgs,
} from "./bind-order.ts";

// —— 解析器自己 ——————————————————————————————————————————————
//
// 這一段存在的理由跟 einkIsolation 那支一樣:**掃描器壞掉的時候是全綠的**,
// 所以掃描器自己要有測試。

test("引數用括號深度切,不是 split(',')", () => {
	assert.deepEqual(splitArgs("email, sid"), ["email", "sid"]);
	// 引數裡的逗號不是分隔符 —— 天真的 split 會把這個切成三段。
	assert.deepEqual(splitArgs("email, Math.min(a, b), sid"), [
		"email",
		"Math.min(a, b)",
		"sid",
	]);
	assert.deepEqual(splitArgs(""), []);
});

test("認得出 ? 前面比的是哪個欄位", () => {
	assert.equal(columnBefore("... AND rp.user_email = "), "user_email");
	assert.equal(columnBefore("WHERE session_id = "), "session_id");
	assert.equal(columnBefore("WHERE question_id IN ("), "question_id");
	// 認不出來就回 null —— 寧可漏,不要誤報。
	assert.equal(columnBefore("WHERE created_at > now() - "), null);
});

// —— 真正要抓的東西 ————————————————————————————————————————————

test("抓得到 2026-08-27 成績頁那個錯位", () => {
	// 這正是 #184 留下的形狀:新的 ? 加在 SQL 最前面,而新的引數插在中間。
	const src = `
		const { results } = await c.env.DB.prepare(
			\`SELECT ea.question_id, rp.last_chosen AS review_last_chosen
         FROM exam_answers ea
         LEFT JOIN review_progress rp
                ON rp.question_id = ea.question_id AND rp.user_email = ?
         LEFT JOIN (
           SELECT question_id FROM attempts WHERE session_id = ?
         ) t ON t.question_id = ea.question_id
        WHERE ea.session_id = ?\`,
		)
			.bind(sid, email, sid)
			.all();
	`;
	const found = findBindOrderIssues(src);
	assert.equal(found.length, 2, `該抓到兩處,實際 ${found.map((f) => f.column)}`);
	assert.deepEqual(
		found.map((f) => [f.index, f.column, f.bound]),
		[
			[1, "user_email", "sid"],
			[2, "session_id", "email"],
		],
	);
});

test("正確的順序不該被抓 —— 否則整支只是噪音", () => {
	const src = `
		await c.env.DB.prepare(
			\`SELECT 1 FROM exam_answers ea
         LEFT JOIN review_progress rp ON rp.user_email = ?
        WHERE ea.session_id = ?\`,
		).bind(email, sid).all();
	`;
	assert.deepEqual(findBindOrderIssues(src), []);
});

test("別名不影響判斷", () => {
	const src =
		'await db.prepare("SELECT 1 FROM t WHERE t.user_email = ?").bind(sid).first();';
	assert.equal(findBindOrderIssues(src).length, 1);
});

test("展開的引數一律跳過 —— 位置對不上任何東西", () => {
	// review.ts 真的有這種寫法(`.bind(...bind)`),不跳過的話它會變成固定誤報。
	const src =
		'await db.prepare("SELECT 1 FROM t WHERE user_email = ?").bind(...args).first();';
	assert.deepEqual(findBindOrderIssues(src), []);
});

test("batch 陣列裡的另一句不會被當成這一句的引數", () => {
	// free-notes.ts 真的有這種寫法。天真的 regex 會跨過去,把下一句的 prepare(...)
	// 當成引數,然後回報一個不存在的違規。
	const src = `
		await c.env.DB.batch([
			c.env.DB.prepare("DELETE FROM free_notes WHERE id = ? AND user_email = ?").bind(id, email),
			c.env.DB.prepare("DELETE FROM free_note_tags WHERE note_id = ?").bind(id),
		]);
	`;
	assert.deepEqual(findBindOrderIssues(src), []);
});

test("? 的數量跟引數數量對不上就跳過(那是另一種錯)", () => {
	const src =
		'await db.prepare("SELECT 1 FROM t WHERE user_email = ? AND x = ?").bind(sid).first();';
	assert.deepEqual(findBindOrderIssues(src), []);
});

// —— 掃真的原始碼 ————————————————————————————————————————————

test("worker/ 底下沒有 bind 錯位", () => {
	const roots = ["worker/routes", "worker/lib"];
	const files: string[] = [];
	for (const dir of roots) {
		const abs = path.resolve(process.cwd(), dir);
		if (!fs.existsSync(abs)) continue;
		for (const f of fs.readdirSync(abs))
			if (f.endsWith(".ts") && !f.endsWith(".test.ts"))
				files.push(path.join(dir, f));
	}
	// 正面對照:真的掃到檔案了。少了這條,cwd 一變就變成空掃的綠燈。
	assert.ok(files.length > 20, `該掃到不少檔案,實際 ${files.length}`);

	const all: string[] = [];
	let checked = 0;
	for (const f of files) {
		const src = fs.readFileSync(path.resolve(process.cwd(), f), "utf8");
		if (/user_email\s*=\s*\?|session_id\s*=\s*\?/.test(src)) checked++;
		for (const i of findBindOrderIssues(src)) all.push(formatIssue(f, i));
	}
	// 第二個對照組:真的有檔案含這些欄位的 placeholder,掃描器不是在空轉。
	assert.ok(checked > 5, `該有不少檔案用到這些欄位,實際 ${checked}`);
	assert.deepEqual(all, [], "\n" + all.join("\n"));
});

test("`)` 與 `.bind(` 之間有註解時仍然掃得到", () => {
	// ⚠️ 這條是實際踩到的:這支寫好之後,我在真正的 exam.ts 那個位置加了一段
	// 說明,整個檔案就被跳過了 —— 而所有測試照樣全綠。守衛靜靜漏掉它要守的那
	// 一行,比沒有守衛更糟。
	const src = `
		await c.env.DB.prepare(
			\`SELECT 1 FROM t WHERE user_email = ?\`,
		)
			// 順序是 SQL 裡 ? 出現的順序
			/* 而不是「重要的排前面」 */
			.bind(sid)
			.all();
	`;
	assert.equal(
		findBindOrderIssues(src).length,
		1,
		"註解不該讓整段被跳過",
	);
});

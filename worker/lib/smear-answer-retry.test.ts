// 同一場同一題再送一次,smear_answers 仍然只有一列,而且 hint_used 還在。
// 補送走的就是 POST /sessions/:id/answer 這段 INSERT … ON CONFLICT,
// 所以這裡跑的 SQL 是從路由切出來的,不是另抄一份。
// 全真模式的回應維持 {ok:true};判定欄位只在 review 那一支。

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeTestDb } from "./test-d1.ts";

function answerHandler(src: string): string {
	const start = src.indexOf('smearRoutes.post("/sessions/:id/answer"');
	const end = src.indexOf('smearRoutes.post("/sessions/:id/mc-options"');
	assert.ok(start > 0 && end > start, "切不出作答路由,這支測試會變空的綠燈");
	return src.slice(start, end);
}

test("作答是同一列覆寫,補送兩次不會變成兩列,提示也留得住", async () => {
	const src = fs.readFileSync(path.resolve("worker/routes/smear.ts"), "utf8");
	const handler = answerHandler(src);
	const sqlMatch = handler.match(
		/INSERT INTO smear_answers[\s\S]*?answered_at = excluded\.answered_at/,
	);
	assert.ok(sqlMatch, "路由裡找不到 ON CONFLICT 那段 INSERT");
	assert.match(sqlMatch[0], /ON CONFLICT \(session_id, question_id\)/);
	assert.match(sqlMatch[0], /hint_used = excluded\.hint_used/);

	const db = makeTestDb();
	db.exec(`
		INSERT INTO users (email, display_name, created_at, updated_at)
		VALUES ('retry@example.com', 'Retry', 1, 1);
		INSERT INTO smear_dx (id, canonical_long, canonical_abbrev, topic, qtype, created_at)
		VALUES ('dx274', 'Name', NULL, 'rbc', 'cell', 1);
		INSERT INTO smear_questions (
			id, dx_id, source, image_key_view, image_key_full, created_at
		) VALUES ('q274', 'dx274', 'exam', 'v.webp', 'f.webp', 1);
		INSERT INTO smear_sessions (
			id, user_email, mode, config_json, question_ids, started_at
		) VALUES ('sess274', 'retry@example.com', 'exam', '{}', '["q274"]', 1);
	`);

	const sql = sqlMatch[0];
	const write = (hint: string | null, at: number) =>
		db.prepare(sql).bind("sess274", "q274", 0, '["typed"]', "full", 1, "[]", hint, at).run();

	await write("initial", 1000);
	await write("initial", 2000);

	const rows = db.query<{ n: number; hint_used: string | null; answered_at: number }>(
		`SELECT COUNT(*) AS n, hint_used, answered_at
		   FROM smear_answers
		  WHERE session_id = 'sess274' AND question_id = 'q274'`,
	);
	assert.equal(rows.length, 1);
	assert.equal(rows[0].n, 1);
	assert.equal(rows[0].hint_used, "initial");
	assert.equal(rows[0].answered_at, 2000);

	// 漏送提示會把原列寫成 null。客戶端因此必須把 hint_used 原樣帶回去。
	await write(null, 3000);
	const wiped = db.query<{ n: number; hint_used: string | null }>(
		`SELECT COUNT(*) AS n, hint_used FROM smear_answers
		  WHERE session_id = 'sess274' AND question_id = 'q274'`,
	);
	assert.equal(wiped.length, 1);
	assert.equal(wiped[0].n, 1);
	assert.equal(wiped[0].hint_used, null);
});

test("全真模式的作答回應只有 ok,正解留在複習那一支", () => {
	const src = fs.readFileSync(path.resolve("worker/routes/smear.ts"), "utf8");
	const handler = answerHandler(src);
	const reviewAt = handler.indexOf('if (session.mode === "review")');
	const examAt = handler.lastIndexOf("return c.json");
	assert.ok(reviewAt > 0 && examAt > reviewAt);
	const examReturn = handler.slice(examAt, handler.indexOf(";", examAt));
	assert.match(examReturn, /ok:\s*true/);
	assert.equal(examReturn.includes("canonical"), false);
	assert.equal(examReturn.includes("tier"), false);
	assert.match(handler.slice(reviewAt, examAt), /canonical/);
});

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

class MemStorage {
	map = new Map<string, string>();
	getItem(k: string) {
		return this.map.has(k) ? this.map.get(k)! : null;
	}
	setItem(k: string, v: string) {
		this.map.set(k, v);
	}
	removeItem(k: string) {
		this.map.delete(k);
	}
}
const store = new MemStorage();
(globalThis as unknown as { localStorage: MemStorage }).localStorage = store;

const {
	enqueue,
	remove,
	list,
	peek,
	flush,
	dropSession,
	clear,
	mergeExamAnswers,
	examAnswerErrorIsDone,
} = await import("./examOutbox.ts");

beforeEach(() => {
	store.map.clear();
	clear();
});

function put(chosen: string, question_id = "113-001", session_id = "s1") {
	return enqueue({ session_id, question_id, chosen, elapsed_ms: 1000 });
}

test("同一選項再入列沿用同一把 idem,補送不會變成兩筆", () => {
	const a = put("B");
	const b = put("B");
	assert.equal(a.idem, b.idem);
	assert.equal(list().length, 1);
});

test("改選項換一把新鍵,而且只留最新的那筆", () => {
	const a = put("A");
	const b = put("C");
	assert.notEqual(a.idem, b.idem);
	assert.equal(list().length, 1);
	assert.equal(list()[0].chosen, "C");
	assert.equal(peek("s1", "113-001")?.idem, b.idem);
});

test("失敗後重送打的是同一筆", async () => {
	const item = put("D");
	const seen: string[] = [];
	const first = await flush(async () => {
		seen.push("fail");
		throw new Error("offline");
	});
	assert.deepEqual(first, { sent: 0, failed: 1 });
	assert.equal(list()[0].idem, item.idem);
	const second = await flush(async (a) => {
		seen.push(a.idem);
	});
	assert.deepEqual(second, { sent: 1, failed: 0 });
	assert.deepEqual(seen, ["fail", item.idem]);
	assert.equal(list().length, 0);
});

test("第一筆失敗就停,後面的還在", async () => {
	put("A", "113-001");
	put("B", "113-002");
	const r = await flush(async (a) => {
		if (a.question_id === "113-001") throw new Error("offline");
	});
	assert.equal(r.sent, 0);
	assert.equal(r.failed, 2);
	assert.equal(list().length, 2);
});

test("交卷成功後這場的佇列清掉,其他場次留著", () => {
	put("A", "113-001", "s1");
	put("B", "113-002", "s2");
	dropSession("s1");
	assert.equal(list().length, 1);
	assert.equal(list()[0].session_id, "s2");
});

test("重整:佇列裡的選項蓋過伺服器還沒有的,已確認的留著", () => {
	const merged = mergeExamAnswers(
		{ "113-001": "A", "113-002": "B" },
		[{ question_id: "113-002", chosen: "E" }, { question_id: "113-003", chosen: "C" }],
	);
	assert.deepEqual(merged, {
		"113-001": "A",
		"113-002": "E",
		"113-003": "C",
	});
});

test("已交卷、找不到、或不是本人的錯誤不必再補", () => {
	assert.equal(examAnswerErrorIsDone(400, "session already finished"), true);
	assert.equal(examAnswerErrorIsDone(404, "session not found"), true);
	assert.equal(examAnswerErrorIsDone(403, "forbidden"), true);
	assert.equal(examAnswerErrorIsDone(400, "forbidden"), false);
	assert.equal(examAnswerErrorIsDone(500, "session already finished"), false);
	assert.equal(examAnswerErrorIsDone(400, "invalid"), false);
});

test("送成功才從佇列拿掉", () => {
	const item = put("A");
	remove(item.idem);
	assert.equal(peek("s1", "113-001"), undefined);
});

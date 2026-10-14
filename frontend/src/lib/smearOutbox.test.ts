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
	SMEAR_OUTBOX_KEY,
	enqueue,
	remove,
	list,
	listSession,
	peek,
	flush,
	dropSession,
	clear,
	smearAnswerErrorIsDone,
	smearAnswerRequest,
	smearFlushBody,
	smearFlushResult,
} = await import("./smearOutbox.ts");

beforeEach(() => {
	store.map.clear();
	clear();
});

const SECRET = "ZYXWVU-RETRY-CANONICAL-274";

function put(boxes: string[] = ["typed"], hint: string | null = "initial", mode: "review" | "exam" = "review") {
	return enqueue({
		session_id: "sess",
		question_id: "#0",
		boxes,
		hint_used: hint,
		mode,
	});
}

test("同一題同一答案再入列只留一筆,提示也還在", () => {
	const a = put();
	const b = put();
	assert.equal(a.queued_at, b.queued_at);
	assert.equal(list().length, 1);
	assert.equal(peek("sess", "#0")?.hint_used, "initial");
	assert.deepEqual(smearAnswerRequest(b).body, {
		questionId: "#0",
		boxes: ["typed"],
		hintUsed: "initial",
	});
});

test("改了答案或提示就換成新的一筆,補送不會沿用舊的", () => {
	put(["typed"], "initial");
	const next = put(["typed"], "mc_choice");
	assert.equal(list().length, 1);
	assert.equal(next.hint_used, "mc_choice");
	assert.equal(smearAnswerRequest(next).body.hintUsed, "mc_choice");
	put(["other"], "mc_choice");
	assert.deepEqual(list()[0].boxes, ["other"]);
});

test("失敗後重送的是同一份 boxes 與 hint_used", async () => {
	const item = put(["typed-retry"], "initial");
	const first = await flush(async () => {
		throw new Error("offline");
	});
	assert.deepEqual(first, { sent: 0, failed: 1 });
	assert.equal(list()[0].queued_at, item.queued_at);
	const seen: unknown[] = [];
	const second = await flush(async (a) => {
		seen.push(smearAnswerRequest(a).body);
	});
	assert.deepEqual(second, { sent: 1, failed: 0 });
	assert.deepEqual(seen, [
		{ questionId: "#0", boxes: ["typed-retry"], hintUsed: "initial" },
	]);
	assert.equal(list().length, 0);
});

test("第一筆失敗就停,後面的還在", async () => {
	put(["a"], null, "exam");
	enqueue({
		session_id: "sess",
		question_id: "#1",
		boxes: ["b"],
		hint_used: null,
		mode: "exam",
	});
	const r = await flush(async (a) => {
		if (a.question_id === "#0") throw new Error("offline");
	});
	assert.equal(r.sent, 0);
	assert.equal(r.failed, 2);
	assert.equal(listSession("sess").length, 2);
});

test("交卷成功後這場的佇列清掉,其他場次留著", () => {
	put();
	enqueue({
		session_id: "other",
		question_id: "q",
		boxes: ["x"],
		hint_used: null,
		mode: "exam",
	});
	dropSession("sess");
	assert.equal(list().length, 1);
	assert.equal(list()[0].session_id, "other");
});

test("壞掉的佇列不會讓補送停住", async () => {
	store.setItem(
		SMEAR_OUTBOX_KEY,
		JSON.stringify([
			{ no: true },
			{ session_id: "sess", question_id: "q", boxes: [], mode: "review" },
			{
				session_id: "sess",
				question_id: "q2",
				boxes: ["ok"],
				hint_used: "initial",
				mode: "review",
				queued_at: 1,
			},
		]),
	);
	const seen: string[] = [];
	const r = await flush(async (a) => {
		seen.push(a.question_id);
	});
	assert.deepEqual(r, { sent: 1, failed: 0 });
	assert.deepEqual(seen, ["q2"]);
	assert.equal(list().length, 0);
});

test("讀到壞 JSON 就當成空佇列", () => {
	store.setItem(SMEAR_OUTBOX_KEY, "{");
	assert.deepEqual(list(), []);
	put();
	assert.equal(list().length, 1);
});

test("已交卷、找不到、或不是本人的錯誤不必再補", () => {
	assert.equal(smearAnswerErrorIsDone(400, "session already finished"), true);
	assert.equal(smearAnswerErrorIsDone(404, "not found"), true);
	assert.equal(smearAnswerErrorIsDone(403, "forbidden"), true);
	assert.equal(smearAnswerErrorIsDone(400, "questionId and boxes are required"), false);
	assert.equal(smearAnswerErrorIsDone(500, "session already finished"), false);
});

test("全真模式的補送結果不帶正解,複習模式會揭曉", () => {
	const leaked = {
		ok: true,
		tier: "full",
		score: 1,
		canonical: SECRET,
		acceptedTerms: [{ text: SECRET, tier: "full" }],
	};
	assert.deepEqual(smearFlushBody("exam", leaked), { ok: true });
	assert.equal(JSON.stringify(smearFlushBody("exam", leaked)).includes(SECRET), false);
	const exam = smearFlushResult("exam", leaked);
	assert.deepEqual(exam, { kind: "exam-ack" });
	assert.equal(JSON.stringify(exam).includes(SECRET), false);

	const review = smearFlushResult("review", leaked);
	assert.equal(review.kind, "grade");
	if (review.kind !== "grade") return;
	assert.equal(review.display.canonical, SECRET);
	assert.equal(review.display.tier, "full");
});

test("送成功才從佇列拿掉", () => {
	put();
	remove("sess", "#0");
	assert.equal(peek("sess", "#0"), undefined);
});

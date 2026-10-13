// 抹片送不出去的作答。跟 attemptOutbox、examOutbox 分開:
// 複習打 /api/review/answer,模擬考打 /api/exam/:sid/answer,
// 這裡打 /api/smear/sessions/:id/answer。混進前兩個佇列,補送會寫錯地方。
//
// 冪等靠 smear_answers 的 PRIMARY KEY (session_id, question_id)。
// 同一題再送是 ON CONFLICT UPDATE,不會多一列。所以這裡不另發
// Idempotency-Key —— 換一把鍵在模擬考會再 append 一筆,在抹片沒有那個語意。
//
// 送出之前就入列。請求失敗、重整、分頁關掉,這題都還在。
// hint_used 要原樣重送:伺服器的 UPDATE 會把漏送的提示寫成 null。

export const SMEAR_OUTBOX_KEY = "mcq:smear-answer-outbox:v1";
const MAX = 300;

export type SmearOutboxMode = "review" | "exam";

export type PendingSmearAnswer = {
	session_id: string;
	question_id: string;
	boxes: string[];
	hint_used: string | null;
	mode: SmearOutboxMode;
	queued_at: number;
};

export type SmearAnswerRequest = {
	path: string;
	body: { questionId: string; boxes: string[]; hintUsed?: string };
};

export type SmearFlushResult =
	| {
			kind: "grade";
			display: {
				tier: "full" | "half" | "lay" | "miss";
				score: number;
				canonical?: string | null;
				spellingErrors?: unknown[];
				acceptedTerms?: unknown[];
			};
	  }
	| { kind: "exam-ack" };

type SmearAnswerInput = {
	session_id: string;
	question_id: string;
	boxes: string[];
	hint_used?: string | null;
	mode: SmearOutboxMode;
};

let cached: PendingSmearAnswer[] = [];

function isBoxes(v: unknown): v is string[] {
	return Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string");
}

function isPending(v: unknown): v is PendingSmearAnswer {
	if (!v || typeof v !== "object") return false;
	const o = v as Record<string, unknown>;
	if (typeof o.session_id !== "string" || !o.session_id) return false;
	if (typeof o.question_id !== "string" || !o.question_id) return false;
	if (!isBoxes(o.boxes)) return false;
	if (o.mode !== "review" && o.mode !== "exam") return false;
	if (o.hint_used != null && typeof o.hint_used !== "string") return false;
	return true;
}

function boxesEqual(a: string[], b: string[]): boolean {
	return a.length === b.length && a.every((x, i) => x === b[i]);
}

function read(): PendingSmearAnswer[] {
	try {
		const raw = localStorage.getItem(SMEAR_OUTBOX_KEY);
		if (!raw) {
			cached = [];
			return cached;
		}
		const v = JSON.parse(raw);
		cached = Array.isArray(v) ? v.filter(isPending) : [];
	} catch {
		cached = [];
	}
	return cached;
}

function write(items: PendingSmearAnswer[]): void {
	const next = items.slice(-MAX);
	try {
		localStorage.setItem(SMEAR_OUTBOX_KEY, JSON.stringify(next));
	} catch {
		/* 配額滿或私密瀏覽:當次仍會嘗試直送 */
	}
	cached = next;
}

cached = read();

export function list(): PendingSmearAnswer[] {
	return read();
}

export function listSession(sessionId: string): PendingSmearAnswer[] {
	return read().filter((x) => x.session_id === sessionId);
}

export function peek(sessionId: string, questionId: string): PendingSmearAnswer | undefined {
	return read().find((x) => x.session_id === sessionId && x.question_id === questionId);
}

export function size(): number {
	return cached.length;
}

/** 同一場同一題只留一筆。內容相同就沿用原來那筆,讓補送打到同一列。 */
export function enqueue(input: SmearAnswerInput): PendingSmearAnswer {
	const hint = input.hint_used ?? null;
	const items = read();
	const prev = items.find(
		(x) => x.session_id === input.session_id && x.question_id === input.question_id,
	);
	if (
		prev &&
		prev.mode === input.mode &&
		prev.hint_used === hint &&
		boxesEqual(prev.boxes, input.boxes)
	) {
		return prev;
	}
	const item: PendingSmearAnswer = {
		session_id: input.session_id,
		question_id: input.question_id,
		boxes: input.boxes,
		hint_used: hint,
		mode: input.mode,
		queued_at: Date.now(),
	};
	const next = items.filter(
		(x) => !(x.session_id === input.session_id && x.question_id === input.question_id),
	);
	next.push(item);
	write(next);
	return item;
}

export function remove(sessionId: string, questionId: string): void {
	const items = read();
	const next = items.filter(
		(x) => !(x.session_id === sessionId && x.question_id === questionId),
	);
	if (next.length === items.length) return;
	write(next);
}

/** 交卷成功之後這場不必再補。其他場次留著。 */
export function dropSession(sessionId: string): void {
	const items = read();
	const next = items.filter((x) => x.session_id !== sessionId);
	if (next.length === items.length) return;
	write(next);
}

export function clear(): void {
	write([]);
}

/**
 * 這場已經收掉、不存在、或不是本人的。再送只會一直失敗,
 * 而且 flush 一停就把後面其他場次一起卡住。
 * 400 只收「已經交卷」——別的 400 可能是這次內容有問題,留著下次再試。
 */
export function smearAnswerErrorIsDone(status: number, error: unknown): boolean {
	if (status === 404 || status === 403) return true;
	if (status !== 400) return false;
	return /already finished/.test(String(error ?? ""));
}

/** 補送的網址與本文。hint_used 有值就一定帶上,不能省略。 */
export function smearAnswerRequest(item: PendingSmearAnswer): SmearAnswerRequest {
	return {
		path: `/api/smear/sessions/${item.session_id}/answer`,
		body: {
			questionId: item.question_id,
			boxes: item.boxes,
			...(item.hint_used ? { hintUsed: item.hint_used } : {}),
		},
	};
}

/**
 * 全真模式的補送回應只留一個確認。就算伺服器多塞了判定欄位,
 * 也不進佇列、不進畫面。
 */
export function smearFlushBody(mode: SmearOutboxMode, body: unknown): unknown {
	if (mode !== "review") return { ok: true };
	return body;
}

export function smearFlushResult(mode: SmearOutboxMode, body: unknown): SmearFlushResult {
	if (mode !== "review") return { kind: "exam-ack" };
	if (!body || typeof body !== "object") return { kind: "exam-ack" };
	const o = body as Record<string, unknown>;
	if (o.tier !== "full" && o.tier !== "half" && o.tier !== "lay" && o.tier !== "miss") {
		return { kind: "exam-ack" };
	}
	if (typeof o.score !== "number") return { kind: "exam-ack" };
	return {
		kind: "grade",
		display: {
			tier: o.tier,
			score: o.score,
			canonical: typeof o.canonical === "string" ? o.canonical : null,
			spellingErrors: Array.isArray(o.spellingErrors) ? o.spellingErrors : [],
			acceptedTerms: Array.isArray(o.acceptedTerms) ? o.acceptedTerms : [],
		},
	};
}

export async function flush(
	post: (item: PendingSmearAnswer) => Promise<unknown>,
): Promise<{ sent: number; failed: number }> {
	const items = read();
	let sent = 0;
	for (const item of items) {
		try {
			await post(item);
			remove(item.session_id, item.question_id);
			sent++;
		} catch {
			return { sent, failed: items.length - sent };
		}
	}
	return { sent, failed: 0 };
}

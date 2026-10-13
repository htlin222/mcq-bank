// 模擬考送不出去的答案。跟 attemptOutbox 分開,因為補送的網址不同:
// 複習打 /api/review/answer,這裡打 /api/exam/:sid/answer。混在同一個佇列,
// 補送器分不出該打哪一支,就會把考卷答案寫進複習進度。
//
// 同一場同一題只留最新的一筆。選項沒變就沿用原來的 idem —— 補送兩次打到的是
// 伺服器已經記過的那把鍵,不會再 append 一筆內容相同的 attempt。選項變了才
// 換鍵:那是一次新的作答,跟線上改答案會多一筆 attempt 是同一件事。
//
// 重整之後讀得到。choose() 在 POST 之前就入列,所以 400ms debounce 還沒觸發
// 就關掉分頁,這題也還在。

const KEY = "mcq:exam-answer-outbox:v1";
const MAX = 300;

export type PendingExamAnswer = {
	idem: string;
	session_id: string;
	question_id: string;
	chosen: string;
	elapsed_ms: number | null;
	queued_at: number;
};

type ExamAnswerInput = {
	session_id: string;
	question_id: string;
	chosen: string;
	elapsed_ms: number | null;
};

let cached: PendingExamAnswer[] = [];
const listeners = new Set<() => void>();

function isPending(v: unknown): v is PendingExamAnswer {
	if (!v || typeof v !== "object") return false;
	const o = v as Record<string, unknown>;
	return (
		typeof o.idem === "string" &&
		typeof o.session_id === "string" &&
		typeof o.question_id === "string" &&
		typeof o.chosen === "string"
	);
}

function read(): PendingExamAnswer[] {
	try {
		const raw = localStorage.getItem(KEY);
		if (!raw) return [];
		const v = JSON.parse(raw);
		return Array.isArray(v) ? v.filter(isPending) : [];
	} catch {
		return [];
	}
}

function write(items: PendingExamAnswer[]): void {
	const next = items.slice(-MAX);
	try {
		localStorage.setItem(KEY, JSON.stringify(next));
	} catch {
		/* 配額滿或私密瀏覽:當次仍會嘗試直送 */
	}
	cached = next;
	for (const fn of listeners) fn();
}

cached = read();

export function getSnapshot(): PendingExamAnswer[] {
	return cached;
}

export function subscribe(fn: () => void): () => void {
	listeners.add(fn);
	return () => listeners.delete(fn);
}

/** 入列。同一場同一題只留最新的一筆;選項相同則回傳原來那筆(同一把 idem)。 */
export function enqueue(input: ExamAnswerInput): PendingExamAnswer {
	const items = read();
	const prev = items.find(
		(x) => x.session_id === input.session_id && x.question_id === input.question_id,
	);
	if (prev && prev.chosen === input.chosen) return prev;
	const item: PendingExamAnswer = {
		...input,
		idem: crypto.randomUUID(),
		queued_at: Date.now(),
	};
	const next = items.filter(
		(x) => !(x.session_id === input.session_id && x.question_id === input.question_id),
	);
	next.push(item);
	write(next);
	return item;
}

export function remove(idem: string): void {
	const items = read();
	const next = items.filter((x) => x.idem !== idem);
	if (next.length === items.length) return;
	write(next);
}

export function peek(sessionId: string, questionId: string): PendingExamAnswer | undefined {
	return cached.find((x) => x.session_id === sessionId && x.question_id === questionId);
}

export function listSession(sessionId: string): PendingExamAnswer[] {
	return cached.filter((x) => x.session_id === sessionId);
}

export function list(): PendingExamAnswer[] {
	return cached;
}

export function size(): number {
	return cached.length;
}

/** 交卷的 PUT 已經把這場的答案寫進 exam_answers。留下的佇列再補送會再 append 一次。 */
export function dropSession(sessionId: string): void {
	const next = read().filter((x) => x.session_id !== sessionId);
	if (next.length === cached.length) return;
	write(next);
}

export function clear(): void {
	write([]);
}

/**
 * 伺服器已經把這場收掉了。這筆再送只會一直 400,而且 flush 一失敗就停,
 * 會把後面其他場次的答案一起卡住。
 */
export function examAnswerErrorIsDone(status: number, error: unknown): boolean {
	// 404 場次不在、403 不是這個人的。兩者再送也不會成功。
	// 400 只收「已經交卷」——別的 400 可能是這次的內容有問題,留著下次再試。
	// 伺服器的 forbidden 是 403,不是 400。
	if (status === 404 || status === 403) return true;
	if (status !== 400) return false;
	return /already finished/.test(String(error ?? ""));
}

export async function flush(
	post: (a: PendingExamAnswer) => Promise<unknown>,
): Promise<{ sent: number; failed: number }> {
	const items = read();
	let sent = 0;
	for (const a of items) {
		try {
			await post(a);
			remove(a.idem);
			sent++;
		} catch {
			return { sent, failed: items.length - sent };
		}
	}
	return { sent, failed: 0 };
}

/** 重整後畫面上的答案。後寫的覆蓋先寫的,所以佇列裡的選項蓋過伺服器還沒有的那格。 */
export function mergeExamAnswers(
	server: Record<string, string>,
	overlays: { question_id: string; chosen: string }[],
): Record<string, string> {
	const out = { ...server };
	for (const o of overlays) out[o.question_id] = o.chosen;
	return out;
}

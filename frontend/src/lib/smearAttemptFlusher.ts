// 抹片作答的補送。觸發點跟模擬考那支一樣,而且同樣不看 navigator.onLine
// (BOOX 省電模式會把那個值卡在 false)。見 examAttemptFlusher.ts。
//
// 補送打的是原本的 /answer。全真模式那支只回 {ok:true};這裡再擋一次,
// 回應進到頁面之前就丟掉判定欄位。

import { api } from "./api";
import {
	flush,
	size,
	smearAnswerErrorIsDone,
	smearAnswerRequest,
	smearFlushBody,
	type PendingSmearAnswer,
} from "./smearOutbox";

export type SmearFlushHit = { item: PendingSmearAnswer; body: unknown };

type Outcome = { hits: SmearFlushHit[]; failed: number };

const listeners = new Set<(hit: SmearFlushHit) => void>();
const recent = new Map<string, SmearFlushHit>();

let inflight: Promise<Outcome> | null = null;

function keyOf(item: PendingSmearAnswer): string {
	return `${item.session_id}\0${item.question_id}`;
}

function remember(hit: SmearFlushHit): void {
	recent.set(keyOf(hit.item), hit);
	for (const fn of listeners) fn(hit);
}

export function subscribeSmearFlush(fn: (hit: SmearFlushHit) => void): () => void {
	listeners.add(fn);
	return () => listeners.delete(fn);
}

/** 這場在訂閱掛上之前就補送成功的回應。取走就清掉。 */
export function consumeSmearFlush(sessionId: string): SmearFlushHit[] {
	const out: SmearFlushHit[] = [];
	for (const [key, hit] of recent) {
		if (hit.item.session_id !== sessionId) continue;
		out.push(hit);
		recent.delete(key);
	}
	return out;
}

async function run(): Promise<Outcome> {
	const hits: SmearFlushHit[] = [];
	const result = await flush(async (item) => {
		try {
			const req = smearAnswerRequest(item);
			const raw = await api.post(req.path, req.body);
			const hit = { item, body: smearFlushBody(item.mode, raw) };
			hits.push(hit);
			remember(hit);
		} catch (e) {
			const err = e as { status?: number; data?: { error?: unknown } };
			if (smearAnswerErrorIsDone(err?.status ?? 0, err?.data?.error)) return;
			throw e;
		}
	});
	return { hits, failed: result.failed };
}

export function flushSmearAttempts(): Promise<Outcome> {
	if (inflight) return inflight;
	inflight = run().finally(() => {
		inflight = null;
	});
	return inflight;
}

let installed = false;
export function installSmearAttemptFlusher(): void {
	if (installed || typeof window === "undefined") return;
	installed = true;
	void flushSmearAttempts();
	window.addEventListener("online", () => void flushSmearAttempts());
	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState === "visible") void flushSmearAttempts();
	});
	window.addEventListener("pagehide", () => {
		if (size() > 0) void flushSmearAttempts();
	});
}

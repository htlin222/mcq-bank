// 模擬考答案的補送。觸發點跟複習那支一樣,而且同樣不看 navigator.onLine
// (BOOX 省電模式會把那個值卡在 false)。見 attemptFlusher.ts。

import { api } from "./api";
import {
	examAnswerErrorIsDone,
	flush,
	size,
	type PendingExamAnswer,
} from "./examOutbox";

let running = false;

export async function flushExamAttempts(): Promise<void> {
	if (running) return;
	if (size() === 0) return;
	running = true;
	try {
		await flush(async (a: PendingExamAnswer) => {
			try {
				await api.post(
					`/api/exam/${a.session_id}/answer`,
					{
						question_id: a.question_id,
						chosen: a.chosen,
						elapsed_ms: a.elapsed_ms,
					},
					a.idem,
				);
			} catch (e) {
				const err = e as { status?: number; data?: { error?: unknown } };
				if (examAnswerErrorIsDone(err?.status ?? 0, err?.data?.error)) return;
				throw e;
			}
		});
	} finally {
		running = false;
	}
}

let installed = false;
export function installExamAttemptFlusher(): void {
	if (installed || typeof window === "undefined") return;
	installed = true;
	void flushExamAttempts();
	window.addEventListener("online", () => void flushExamAttempts());
	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState === "visible") void flushExamAttempts();
	});
	window.addEventListener("pagehide", () => {
		if (size() > 0) void flushExamAttempts();
	});
}

// 把 attemptOutbox 裡積著的作答補送出去。
//
// **刻意不放在元件裡。** 補送的整個重點就是「使用者已經離開那一題了」——
// 掛在 QuestionCard 上等於換題就沒了,那正是 113-097～100 那四題消失的原因。
// 這裡是模組層的單例:訂閱一次，活得比任何一個畫面久。
//
// 觸發時機挑的是「網路狀況剛剛改變」的那幾個瞬間,不是定時輪詢 ——
// e-ink 平板多半靠電池,每分鐘醒來打一次網路是實實在在的耗電,而且佇列在
// 99% 的時間裡是空的。

import { api } from "./api";
import { flush, size, type PendingAttempt } from "./attemptOutbox";

let running = false;
let listeners: Array<(pending: number) => void> = [];

function notify() {
	const n = size();
	for (const fn of listeners) fn(n);
}

/** 訂閱待送筆數,給 UI 顯示「N 筆未送出」。回傳解除訂閱。 */
export function subscribePending(fn: (pending: number) => void): () => void {
	listeners.push(fn);
	fn(size());
	return () => {
		listeners = listeners.filter((x) => x !== fn);
	};
}

/**
 * 補送一次。併發呼叫只會有一趟在飛 —— online 事件與 visibilitychange 常常
 * 前後腳觸發,重入會讓同一筆被送兩次(雖然 idempotency key 擋得住重複計分,
 * 但那是白費的網路)。
 */
export async function flushAttempts(): Promise<void> {
	if (running) return;
	if (size() === 0) return;

	// **刻意不看 `navigator.onLine`。** 直覺上「離線就別白費一次 timeout」是對的,
	// 但那個值在 Android WebView 上不可靠 —— 而這個功能存在的理由,正是一台
	// 會自己把 WiFi 關掉的 Android 平板(BOOX 的省電模式)。它可能在網路已經
	// 回來之後仍卡在 false,那樣補送就永遠不會執行:佇列存住了,卻送不出去,
	// 等於白做。
	//
	// 代價有界:`flush()` 遇到第一個失敗就停,所以離線時最多付**一次** timeout,
	// 而且觸發點只有四個事件(不是輪詢)。用一次 timeout 換「不會永久卡住」,划算。

	running = true;
	try {
		await flush((a: PendingAttempt) =>
			api.post(
				"/api/review/answer",
				{
					question_id: a.question_id,
					chosen: a.chosen,
					confidence: a.confidence,
					elapsed_ms: a.elapsed_ms,
				},
				a.idem,
			),
		);
	} finally {
		running = false;
		notify();
	}
}

/** 掛上觸發點。App 啟動時呼叫一次即可(重複呼叫是安全的)。 */
let installed = false;
export function installAttemptFlusher(): void {
	if (installed || typeof window === "undefined") return;
	installed = true;

	// 1) 啟動時:上一輪沒送成功的,開 app 就補。
	void flushAttempts();

	// 2) 重新連上網路。
	window.addEventListener("online", () => void flushAttempts());

	// 3) 分頁切回前景 —— e-ink 平板常常是「闔上蓋子走人、隔天再打開」,
	//    那時 online 事件不會再發一次,但網路可能已經好了。
	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState === "visible") void flushAttempts();
	});

	// 4) 關閉前最後一搏。sendBeacon 在頁面卸載時仍會送出,fetch 不保證 ——
	//    但它送不了自訂 header(冪等鍵走 header),所以只能當補充,不能取代
	//    佇列本身。送不出去也沒關係:佇列還在,下次開 app 會補。
	window.addEventListener("pagehide", () => {
		if (size() > 0) void flushAttempts();
	});
}

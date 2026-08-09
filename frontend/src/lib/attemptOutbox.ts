// 作答的離線佇列 —— 送不出去的先存起來，之後補送。
//
// 為什麼需要它:2026-08-09 在 e-ink 平板上連續四題(113-097～100)完全沒有進 D1。
// `attempts` 與 `review_progress` 都是 0 筆,換一台裝置看也一樣 —— 不是快取問題,
// 是那四趟 POST 根本沒到伺服器。
//
// 而且它**是靜默的**:失敗時 QuestionCard 只設了一個 `saveFailed` state,而使用者
// 按下一題之後那個元件就換題重繪了,提示沒有機會被看見。使用者感覺到的是「答了
// 一整輪,回頭發現全部沒記錄」。
//
// 這推翻了「PWA 只離線讀、不離線寫」那條原則的一半。原則的理由是「寫入衝突的
// 複雜度不值得」—— 對詳解共筆成立(兩個人改同一段要處理合併),但作答不是共筆:
// 一筆作答只屬於一個人、只會被寫一次,而且 `/api/review/answer` 本來就帶
// idempotency key。重送一筆已經成功的作答不會多算一次。沒有衝突要解,自然也就
// 沒有那個複雜度。
//
// 刻意用 localStorage 而不是 IndexedDB:一筆約 120 bytes,常態佇列長度是 0,
// 最壞情況(整場模擬考斷網)也只有 100 筆。同步 API 讓「送出前先入列」不必是
// async —— 那一步絕對不能失敗,否則就回到原點了。

const KEY = "mcq:attempt-outbox:v1";
/** 超過就丟最舊的。斷網整場模擬考約 100 筆,留三倍餘裕。 */
const MAX = 300;

export type PendingAttempt = {
	/** 伺服器端的冪等鍵。重送同一筆不會多算一次。 */
	idem: string;
	question_id: string;
	chosen: string;
	confidence: number | null;
	elapsed_ms: number | null;
	/** 入列時間,只用於排序與診斷 */
	queued_at: number;
};

function read(): PendingAttempt[] {
	try {
		const raw = localStorage.getItem(KEY);
		if (!raw) return [];
		const v = JSON.parse(raw);
		return Array.isArray(v) ? v.filter(isPending) : [];
	} catch {
		// 壞掉的 JSON、Safari 私密瀏覽 —— 兩者都當成空佇列。這支的每個呼叫端都
		// 在「使用者正在作答」的路徑上,不能因為讀不到佇列就丟例外。
		return [];
	}
}

function isPending(v: unknown): v is PendingAttempt {
	if (!v || typeof v !== "object") return false;
	const o = v as Record<string, unknown>;
	return typeof o.idem === "string" && typeof o.question_id === "string" && typeof o.chosen === "string";
}

function write(items: PendingAttempt[]): void {
	try {
		localStorage.setItem(KEY, JSON.stringify(items.slice(-MAX)));
	} catch {
		/* 配額滿或私密瀏覽:當次仍會嘗試直送,只是失敗後補不回來 */
	}
}

/** 送出前呼叫。同一個 idem 重複入列只會留一筆(重試時不會長出兩筆)。 */
export function enqueue(a: PendingAttempt): void {
	const items = read().filter((x) => x.idem !== a.idem);
	items.push(a);
	write(items);
}

/** 送出成功後呼叫。 */
export function remove(idem: string): void {
	write(read().filter((x) => x.idem !== idem));
}

export function list(): PendingAttempt[] {
	return read();
}

export function size(): number {
	return read().length;
}

export function clear(): void {
	write([]);
}

/**
 * 把佇列送出去。回傳 { sent, failed } —— 呼叫端用它決定要不要顯示提示。
 *
 * 逐筆循序送,不平行:弱網路下平行只會讓每一筆都更容易 timeout,而且順序有意義
 * (同一題答兩次時,後送的那筆才是最終答案)。
 *
 * 遇到第一個失敗就停:那通常表示網路還是不通,把剩下的送出去只是白費電池,
 * 而且會把佇列裡的順序打亂。
 */
export async function flush(
	post: (a: PendingAttempt) => Promise<unknown>,
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

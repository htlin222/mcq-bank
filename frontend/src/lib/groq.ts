// BYOK (bring your own key) Groq 客戶端 —— 完全在瀏覽器裡。
//
// 金鑰只存 localStorage,直接放進送往 api.groq.com 的 Authorization header。
// 它**絕不**經過我們的 Worker、**絕不**進 D1。代價講明白:換裝置要重設、
// 清瀏覽器資料就沒了。這是刻意的取捨,不是還沒做的同步功能。
//
// api.groq.com 允許瀏覽器 CORS(`access-control-allow-origin: *`,且
// `access-control-allow-headers` 含 authorization),所以直連可行。唯一的前
// 提是 CSP:frontend/public/_headers 的 connect-src 必須含 api.groq.com,
// 否則 fetch 會在送出前就被瀏覽器擋掉。

const KEY_STORAGE = "byok:groq:key";
const MODEL_STORAGE = "byok:groq:model";

const BASE = "https://api.groq.com/openai/v1";

export const DEFAULT_MODEL = "llama-3.3-70b-versatile";

// 還沒做過健康檢查(拿不到真實清單)時的候選。健康檢查成功後一律改用帳號
// 實際回報的清單 —— Groq 下架模型的頻率不低,寫死的名單只能當起步。
export const FALLBACK_MODELS = [
	"llama-3.3-70b-versatile",
	"llama-3.1-8b-instant",
	"openai/gpt-oss-120b",
	"openai/gpt-oss-20b",
	"qwen/qwen3-32b",
];

// ── 金鑰 / 模型:localStorage ──

export function getKey(): string {
	try {
		return localStorage.getItem(KEY_STORAGE) ?? "";
	} catch {
		return "";
	}
}

export function setKey(key: string): void {
	try {
		if (key) localStorage.setItem(KEY_STORAGE, key);
		else localStorage.removeItem(KEY_STORAGE);
	} catch {
		/* quota / 無痕模式 —— 這輪還是能用,只是不會被記住 */
	}
}

export function hasKey(): boolean {
	return getKey().trim().length > 0;
}

export function getModel(): string {
	try {
		return localStorage.getItem(MODEL_STORAGE) || DEFAULT_MODEL;
	} catch {
		return DEFAULT_MODEL;
	}
}

export function setModel(model: string): void {
	try {
		localStorage.setItem(MODEL_STORAGE, model);
	} catch {
		/* ignore */
	}
}

/** `gsk_abc…wxyz` → `gsk_abc••••••••wxyz`,給設定畫面顯示用。 */
export function maskKey(key: string): string {
	if (key.length <= 12) return "•".repeat(key.length);
	return `${key.slice(0, 7)}${"•".repeat(8)}${key.slice(-4)}`;
}

// ── 錯誤 ──

export class GroqError extends Error {
	// 明確宣告欄位而非用 constructor parameter property:`node --test` 的
	// TypeScript strip-only 模式不支援後者,單元測試會直接掛在 import。
	status: number | null;

	constructor(message: string, status: number | null) {
		super(message);
		this.status = status;
	}
}

// HTTP 狀態 → 使用者看得懂的中文。每一條都要能指出下一步做什麼,
// 否則使用者只會看到一個死巷。
function messageFor(status: number, model: string, detail: string): string {
	if (status === 401) return "金鑰無效或已撤銷,請到設定重新輸入。";
	if (status === 403) return "這把金鑰沒有呼叫此模型的權限。";
	if (status === 429) return "Groq 額度用盡或請求過快,稍後再試。";
	if (status === 404 || status === 400) {
		// Groq 對已下架的模型回 404 / 400 model_not_found,兩者都要導向重選。
		if (/model/i.test(detail)) return `模型「${model}」不可用,請到設定重選。`;
		return `Groq 拒絕了這個請求:${detail || "格式錯誤"}`;
	}
	if (status >= 500) return "Groq 伺服器暫時異常,稍後再試。";
	return `Groq 回應 ${status}:${detail}`;
}

async function toError(res: Response, model: string): Promise<GroqError> {
	let detail = "";
	try {
		const body = (await res.json()) as any;
		detail = body?.error?.message ?? "";
	} catch {
		/* 非 JSON 錯誤頁 */
	}
	return new GroqError(messageFor(res.status, model, detail), res.status);
}

// fetch 本身 reject 的情形:CSP 擋掉、離線、DNS 失敗。全都長得一樣
// (TypeError: Failed to fetch),所以只能給一個涵蓋性的訊息。
function networkError(): GroqError {
	return new GroqError(
		"連不上 Groq(可能是網路離線,或瀏覽器阻擋了這個連線)。",
		null,
	);
}

// ── 健康檢查 ──

export type HealthResult = { ok: true; models: string[] } | { ok: false; message: string };

// 非對話用途的模型,不該出現在下拉選單裡。
const NON_CHAT = /whisper|tts|guard|embed|moderation|distil/i;

/**
 * 驗證金鑰並取回可用模型清單。用 /models 而不是發一則 completion:
 * 免費、不耗 token,而且同一次呼叫就把下拉選單要的資料拿到手。
 */
export async function checkHealth(key: string): Promise<HealthResult> {
	let res: Response;
	try {
		res = await fetch(`${BASE}/models`, {
			headers: { Authorization: `Bearer ${key.trim()}` },
		});
	} catch {
		return { ok: false, message: networkError().message };
	}
	if (!res.ok) {
		const e = await toError(res, "");
		return { ok: false, message: e.message };
	}
	const body = (await res.json()) as { data?: Array<{ id?: string }> };
	const models = (body.data ?? [])
		.map((m) => m.id)
		.filter((id): id is string => typeof id === "string" && !NON_CHAT.test(id))
		.sort();
	return { ok: true, models };
}

// ── SSE 串流解析 ──

/**
 * 從 OpenAI 相容的 SSE 串流中萃取文字增量。
 *
 * 匯出是為了單元測試 —— 網路 chunk 的切點是任意的,`data: {…}` 很可能被
 * 攔腰切成兩半,所以解析器必須自己保留 buffer,不能假設一個 chunk 就是一則
 * 完整事件。
 */
export function createSseParser(): (chunk: string) => string[] {
	let buffer = "";
	let done = false;

	return (chunk: string): string[] => {
		if (done) return [];
		buffer += chunk;
		const out: string[] = [];

		// 事件以換行分隔;最後一段可能不完整,留在 buffer 裡等下一個 chunk。
		const lines = buffer.split("\n");
		buffer = lines.pop() ?? "";

		for (const raw of lines) {
			const line = raw.trim();
			// keep-alive 空行與註解行(`: ping`)都要跳過。
			if (!line || line.startsWith(":")) continue;
			if (!line.startsWith("data:")) continue;
			const payload = line.slice(5).trim();
			if (payload === "[DONE]") {
				done = true;
				break;
			}
			try {
				const j = JSON.parse(payload);
				const delta = j?.choices?.[0]?.delta?.content;
				if (typeof delta === "string" && delta) out.push(delta);
			} catch {
				// 不完整或畸形的 JSON:丟掉這一則,不要讓整段串流死掉。
			}
		}
		return out;
	};
}

// ── 對話 ──

export type StreamOpts = {
	system: string;
	user: string;
	signal?: AbortSignal;
	onDelta: (text: string) => void;
};

/**
 * 對 Groq 發一則串流 completion,逐塊回呼 `onDelta`。
 *
 * 呼叫端負責 AbortController;中止時直接 return(不視為錯誤),已經串出來的
 * 文字保留在畫面上。
 */
export async function streamChat(opts: StreamOpts): Promise<void> {
	const key = getKey().trim();
	if (!key) throw new GroqError("尚未設定 Groq 金鑰。", null);
	const model = getModel();

	let res: Response;
	try {
		res = await fetch(`${BASE}/chat/completions`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${key}`,
				"Content-Type": "application/json",
			},
			signal: opts.signal,
			body: JSON.stringify({
				model,
				stream: true,
				temperature: 0.3,
				messages: [
					{ role: "system", content: opts.system },
					{ role: "user", content: opts.user },
				],
			}),
		});
	} catch (e) {
		if (isAbort(e)) return;
		throw networkError();
	}

	if (!res.ok) throw await toError(res, model);
	if (!res.body) throw new GroqError("Groq 回應沒有內容。", res.status);

	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	const parse = createSseParser();

	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			for (const delta of parse(decoder.decode(value, { stream: true }))) {
				opts.onDelta(delta);
			}
		}
	} catch (e) {
		if (!isAbort(e)) throw networkError();
	} finally {
		reader.releaseLock();
	}
}

function isAbort(e: unknown): boolean {
	return e instanceof DOMException && e.name === "AbortError";
}

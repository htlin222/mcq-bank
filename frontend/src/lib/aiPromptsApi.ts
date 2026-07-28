import { api } from "./api";
import type { AiPrompt } from "./aiPrompts";

// 使用者自訂提示詞的雲端 CRUD。提示詞存 D1 是為了跨裝置共用;金鑰不在這裡,
// 它只存 localStorage(見 groq.ts)。兩者刻意解耦 —— 沒設金鑰的人一樣能先把
// 提示詞寫好。
//
// 純邏輯(內建清單、變數展開)在 aiPrompts.ts,那個模組不碰網路才測得動。

type ServerPrompt = {
	id: string;
	title: string;
	body: string;
	sort_order: number;
	created_at: number;
	updated_at: number;
};

function toPrompt(p: ServerPrompt): AiPrompt {
	return { id: p.id, title: p.title, body: p.body, builtin: false };
}

export async function listPrompts(): Promise<AiPrompt[]> {
	const r = await api.get<{ prompts: ServerPrompt[] }>("/api/ai/prompts");
	return (r.prompts ?? []).map(toPrompt);
}

export async function createPrompt(
	title: string,
	body: string,
): Promise<AiPrompt> {
	const r = await api.post<{ prompt: ServerPrompt }>("/api/ai/prompts", {
		title,
		body,
	});
	return toPrompt(r.prompt);
}

export async function updatePrompt(
	id: string,
	title: string,
	body: string,
): Promise<void> {
	await api.put(`/api/ai/prompts/${encodeURIComponent(id)}`, { title, body });
}

export async function deletePrompt(id: string): Promise<void> {
	await api.del(`/api/ai/prompts/${encodeURIComponent(id)}`);
}

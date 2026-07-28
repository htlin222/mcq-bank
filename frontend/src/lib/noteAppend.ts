import { generateJSON } from "@tiptap/html";
import { api } from "./api";
import { buildExtensions } from "./tiptap-extensions";
import { markdownToHtml } from "./markdown-paste";
import { normalizeTiptapDoc } from "./tiptap-doc";

// 把 AI 產出的 Markdown 接到使用者的個人筆記尾端。
//
// 一律 append,絕不覆寫:筆記是使用者自己寫的東西,AI 的輸出只是多加一節。
// 標題用 h2 標明來源,之後才看得出哪幾段是機器寫的。

type Doc = { type: "doc"; content: any[] };

function emptyDoc(): Doc {
	return { type: "doc", content: [] };
}

/**
 * Markdown → TipTap JSON,用的是和唯讀渲染完全同一組 extension。
 * 不同組會讓某些節點在解析時被 schema 丟掉,存進去就少一塊。
 */
export function markdownToDoc(markdown: string, heading: string): Doc {
	const html = markdownToHtml(markdown);
	const parsed = generateJSON(html, buildExtensions({ readOnly: true })) as Doc;
	return {
		type: "doc",
		content: [
			{
				type: "heading",
				attrs: { level: 2 },
				content: [{ type: "text", text: heading }],
			},
			...(parsed.content ?? []),
		],
	};
}

/**
 * 讀回目前的筆記、把新內容接在尾端、寫回去。
 *
 * 之所以要先 GET 一次:工具列是全站掛載的,手上沒有題目頁的狀態,而且就算有
 * 也可能是舊的。少一次往返換來的是覆寫掉使用者剛剛打的字,不值得。
 */
export async function appendToNote(
	questionId: string,
	markdown: string,
	heading: string,
): Promise<void> {
	const q = await api.get<{ my_note?: { content_json?: string } | null }>(
		`/api/questions/${encodeURIComponent(questionId)}`,
	);

	let existing: Doc = emptyDoc();
	const raw = q.my_note?.content_json;
	if (raw) {
		try {
			existing = (normalizeTiptapDoc(JSON.parse(raw)) as Doc) ?? emptyDoc();
		} catch {
			// 壞掉的 JSON:當作沒有筆記,把新內容寫成第一段,而不是整個放棄。
			existing = emptyDoc();
		}
	}

	const addition = markdownToDoc(markdown, heading);
	const merged: Doc = {
		type: "doc",
		content: [...(existing.content ?? []), ...addition.content],
	};

	await api.put(`/api/questions/${encodeURIComponent(questionId)}/note`, {
		content_json: merged,
	});
}

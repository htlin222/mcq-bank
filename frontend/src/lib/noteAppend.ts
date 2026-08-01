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
 * 把 AI 的回答存成這一題的一則**新**筆記。
 *
 * 從前是接在既有筆記的尾端,那時一題只能有一則(migration 0036 之前)。現在
 * 開新的一則:機器寫的東西不會插進你自己整理的段落中間,而且下拉選單裡看到的
 * 就是那段回答的標題(筆記名 = 內文第一行,見 lib/noteTitle.ts)。
 *
 * 回傳新筆記的 slot,呼叫端要跳過去看的話用得到。
 */
export async function saveAiNote(
	questionId: string,
	markdown: string,
	heading: string,
): Promise<number> {
	const doc = normalizeTiptapDoc(markdownToDoc(markdown, heading)) as Doc;
	const r = await api.post<{ slot: number }>(
		`/api/questions/${encodeURIComponent(questionId)}/notes`,
		{ content_json: doc ?? emptyDoc() },
	);
	return r.slot;
}

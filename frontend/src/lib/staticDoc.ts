import { createElement, type ReactNode } from "react";
import { normalizeTiptapDoc } from "./tiptap-doc.ts";

// TipTap ProseMirror JSON → React 元素。**不經過 EditorView,也不經過 HTML 字串。**
//
// 為什麼要有這個:唯讀內容原本一律走 `ReadOnlyContent`,而那是一個真的
// `useEditor`。tiptap 2.x 的 `immediatelyRender` 預設是 true,所以每一個唯讀區塊
// 都在 **render phase 同步**建構一次 EditorView —— 建 schema、實例化 15 個
// extension、掛 plugin。量到的代價:一題有 12 則留言時,光是進頁面就建了 14 個
// ProseMirror(留言 12 + 詳解 + 筆記),而使用者連討論串都還沒點開。
//
// 為什麼不用 `generateHTML()` + dangerouslySetInnerHTML:那條路會把文件裡的屬性
// 原樣序列化成標記,而 `content_json` 是使用者可寫的欄位 —— 等於把 XSS 的門打開。
// CLAUDE.md 的「HTML in DB」那條規則要守的就是這件事。React 元素沒有這個問題:
// 文字永遠是文字,屬性由下面這幾個函式逐一決定。
//
// **這個渲染器只服務「純閱讀」的內容。** 需要畫記 / 自動挖空 / 防劇透的地方
// (詳解、個人筆記)仍然要真的 ProseMirror —— 那兩層是 decoration 與 mark,
// 靠的是 EditorView。所以 `AnnotatableContent` 一行都不動。
//
// 寫成 `.ts` + `createElement` 而不是 `.tsx`,是為了讓它進得了 `pnpm test`:
// node 的型別剝離不處理 JSX,而這支的兩個要害(未知節點會不會讓內容整段消失、
// href 有沒有擋住 javascript:)正是最需要單元測試釘住的東西。

const h = createElement;

type AnyNode = {
	type?: string;
	text?: string;
	attrs?: Record<string, any> | null;
	marks?: Array<{ type?: string; attrs?: Record<string, any> | null }> | null;
	content?: AnyNode[] | null;
};

/**
 * 只放行「點下去不會執行程式」的協定。相對路徑(站內連結、`/img/<key>`)照收。
 * 認不得的一律回 null,呼叫端把它降級成純文字 —— 連結消失比連結會執行 JS 好。
 */
export function safeUrl(
	raw: unknown,
	origin = "https://example.invalid",
): string | null {
	if (typeof raw !== "string") return null;
	const url = raw.trim();
	if (!url) return null;
	// `//evil.com` 是 protocol-relative 的**絕對**網址,卻長得像相對路徑 ——
	// 要在下面那個字首判斷之前先擋掉。
	if (url.startsWith("//")) return null;
	if (
		url.startsWith("/") ||
		url.startsWith("#") ||
		url.startsWith("./") ||
		url.startsWith("../")
	) {
		return url;
	}
	// `javascript:` 可以寫成 `java&#9;script:`、大小寫混雜、或前面塞控制字元 ——
	// 交給 URL 解析去正規化,不要自己比對字首。
	try {
		const proto = new URL(url, origin).protocol;
		return proto === "http:" || proto === "https:" || proto === "mailto:"
			? url
			: null;
	} catch {
		return null;
	}
}

// 文字節點的 mark 由內往外包,順序照 marks 陣列 —— ProseMirror 存的就是套用順序,
// 照著包出來的巢狀結構跟 EditorView 畫的一致。
function applyMarks(
	text: string,
	marks: AnyNode["marks"],
	key: string,
): ReactNode {
	let out: ReactNode = text;
	for (const m of marks ?? []) {
		const attrs = m?.attrs ?? {};
		switch (m?.type) {
			case "bold":
				out = h("strong", { key }, out);
				break;
			case "italic":
				out = h("em", { key }, out);
				break;
			case "strike":
				out = h("s", { key }, out);
				break;
			case "code":
				out = h("code", { key }, out);
				break;
			case "highlight":
				out = h("mark", { key }, out);
				break;
			case "link": {
				const href = safeUrl(attrs.href);
				// 站外連結一律 noopener noreferrer —— 這裡的內容是別人寫的。
				if (href)
					out = h(
						"a",
						{ key, href, target: "_blank", rel: "noopener noreferrer" },
						out,
					);
				break;
			}
			// 認不得的 mark 就當它不存在,文字照樣看得到。
			default:
				break;
		}
	}
	return out;
}

function renderChildren(kids: AnyNode[] | null | undefined): ReactNode[] {
	return (kids ?? []).map((n, i) => renderNode(n, String(i)));
}

function renderNode(node: AnyNode | null | undefined, key: string): ReactNode {
	if (!node) return null;
	const attrs = node.attrs ?? {};
	const kids = () => renderChildren(node.content);

	switch (node.type) {
		// 沒有 mark 的文字直接回字串 —— 包一層 <span> 會讓一段話多出幾十個元素,
		// 而 `.tiptap` 的樣式全部掛在區塊標籤上,那層 span 一點作用都沒有。
		case "text":
			return node.marks?.length
				? applyMarks(node.text ?? "", node.marks, key)
				: (node.text ?? "");

		case "paragraph":
			return h("p", { key }, ...kids());

		case "heading": {
			const level = Math.min(3, Math.max(1, Number(attrs.level) || 1));
			return h(`h${level}`, { key }, ...kids());
		}

		case "bulletList":
			return h("ul", { key }, ...kids());

		case "orderedList":
			return h(
				"ol",
				{
					key,
					start: typeof attrs.start === "number" ? attrs.start : undefined,
				},
				...kids(),
			);

		case "listItem":
			return h("li", { key }, ...kids());

		case "blockquote":
			return h("blockquote", { key }, ...kids());

		case "codeBlock":
			return h("pre", { key }, h("code", null, ...kids()));

		case "horizontalRule":
			return h("hr", { key });

		case "hardBreak":
			return h("br", { key });

		case "image": {
			const src = safeUrl(attrs.src);
			if (!src) return null;
			return h("img", {
				key,
				src,
				alt: typeof attrs.alt === "string" ? attrs.alt : "",
				title: typeof attrs.title === "string" ? attrs.title : undefined,
				loading: "lazy",
			});
		}

		// 表格外面那層 `.table-scroll` 是唯讀渲染才有的(見 styles.css):太寬的
		// 表格在容器裡左右捲,而不是把整頁撐破。ReadOnlyContent 是掛載後才用 DOM
		// 補上這一層 —— 這裡直接畫出來,少一次 layout 抖動。
		case "table":
			return h(
				"div",
				{ key, className: "table-scroll" },
				h("table", null, h("tbody", null, ...kids())),
			);

		case "tableRow":
			return h("tr", { key }, ...kids());

		case "tableHeader":
		case "tableCell":
			return h(
				node.type === "tableHeader" ? "th" : "td",
				{
					key,
					colSpan:
						typeof attrs.colspan === "number" ? attrs.colspan : undefined,
					rowSpan:
						typeof attrs.rowspan === "number" ? attrs.rowspan : undefined,
				},
				...kids(),
			);

		// mention / questionRef 的 DOM 要跟 extension 的 renderHTML 一致 ——
		// `.tiptap .mention` / `.tiptap a.qref` 的樣式,以及 App.tsx 攔截
		// `a[data-question-ref]` 改走 react-router 的那段,都是靠這些屬性認人。
		case "mention":
			return h(
				"span",
				{
					key,
					className: "mention",
					"data-type": "mention",
					"data-id": attrs.id ?? undefined,
				},
				`@${String(attrs.label ?? attrs.id ?? "")}`,
			);

		case "questionRef": {
			const id = String(attrs.id ?? "");
			if (!id) return null;
			return h(
				"a",
				{ key, className: "qref", href: `/q/${id}`, "data-question-ref": id },
				`@${id}`,
			);
		}

		// 認不得的節點:有子節點就把子節點畫出來,沒有就跳過。整份文件因為一個未知
		// 節點就消失,是這個 repo 已經踩過的坑(見 lib/tiptap-doc.ts 的說明)。
		default:
			return node.content?.length ? h("span", { key }, ...kids()) : null;
	}
}

export function renderStaticDoc(content: unknown): ReactNode[] {
	const doc = normalizeTiptapDoc(content) as AnyNode | null;
	if (!doc || typeof doc !== "object") return [];
	return renderChildren(doc.type === "doc" ? doc.content : [doc]);
}

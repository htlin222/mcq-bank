import StarterKit from "@tiptap/starter-kit";
import Highlight from "@tiptap/extension-highlight";
import Table from "@tiptap/extension-table";
import TableRow from "@tiptap/extension-table-row";
import TableHeader from "@tiptap/extension-table-header";
import TableCell from "@tiptap/extension-table-cell";
import Image from "@tiptap/extension-image";
import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import Mention from "@tiptap/extension-mention";
import { suggestionConfig, mentionCommand } from "./mention-suggestion";
import { QuestionRef } from "./question-ref";

// 唯讀時 Mention 只需要 schema 與 renderHTML —— suggestion 那個 plugin 是打字時
// 比對 `@` 的機器,對一個永遠不會收到 transaction 的編輯器來說是純開銷。個人筆記
// 一則會切成好幾段、每段一個編輯器,所以這是乘上段數的。
const MentionReadOnly = Mention.extend({ addProseMirrorPlugins: () => [] });

export function buildExtensions(
	opts: { placeholder?: string; readOnly?: boolean } = {},
) {
	const readOnly = opts.readOnly === true;
	return [
		StarterKit.configure({
			heading: { levels: [1, 2, 3] },
		}),
		// Renders as <mark> — yellow marker styling lives in styles.css.
		Highlight,
		// Table support — needed to parse pasted HTML tables (e.g. OpenEvidence
		// summary tables) and to render them in read-only mode. The extension
		// doesn't wrap tables in read-only render, so AnnotatableContent wraps each
		// in a .table-scroll div for horizontal scroll (see styles.css);
		// lib/staticDoc.ts emits that wrapper directly.
		Table.configure({ resizable: false }),
		TableRow,
		TableHeader,
		TableCell,
		Image.configure({ inline: false, allowBase64: false }),
		Link.configure({
			openOnClick: readOnly,
			autolink: true,
			protocols: ["http", "https", "mailto"],
		}),
		// Placeholder 自己就有 showOnlyWhenEditable,唯讀時什麼都不畫 —— 那就別把
		// 它的 decoration plugin 掛上去。
		...(readOnly
			? []
			: [
					Placeholder.configure({
						placeholder: opts.placeholder || "寫下你的想法…",
					}),
				]),
		(readOnly ? MentionReadOnly : Mention).configure({
			HTMLAttributes: { class: "mention" },
			renderText: ({ node }) => `@${node.attrs.label || node.attrs.id}`,
			// Cast: @tiptap/extension-mention's suggestion typing forces
			// MentionNodeAttrs as the props shape, but our command accepts a
			// wider MentionSelection union so we can also insert questionRef.
			suggestion: {
				...suggestionConfig,
				command: mentionCommand,
			} as any,
		}),
		QuestionRef,
	];
}

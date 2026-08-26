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

export function buildExtensions(
	opts: { placeholder?: string; readOnly?: boolean } = {},
) {
	return [
		StarterKit.configure({
			heading: { levels: [1, 2, 3] },
		}),
		// Renders as <mark> — yellow marker styling lives in styles.css.
		Highlight,
		// Table support — needed to parse pasted HTML tables (e.g. OpenEvidence
		// summary tables) and to render them in read-only mode. The extension
		// doesn't wrap tables in read-only render, so ReadOnlyContent wraps each
		// in a .table-scroll div for horizontal scroll (see styles.css).
		Table.configure({ resizable: false }),
		TableRow,
		TableHeader,
		TableCell,
		Image.configure({ inline: false, allowBase64: false }),
		Link.configure({
			openOnClick: opts.readOnly === true,
			autolink: true,
			protocols: ["http", "https", "mailto"],
		}),
		Placeholder.configure({
			placeholder: opts.placeholder || "寫下你的想法…",
		}),
		Mention.configure({
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

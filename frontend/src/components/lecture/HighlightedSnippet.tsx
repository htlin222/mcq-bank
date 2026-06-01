import { useMemo } from "react";

// Control-char markers emitted by the worker's FTS5 snippet() call
// (worker/routes/lectures.ts uses char(1)/char(2) instead of <mark>/</mark>
// so the client can render highlights as React elements rather than HTML —
// no dangerouslySetInnerHTML on user-controlled PDF / note text).
const MARK_START = String.fromCharCode(0x01);
const MARK_END = String.fromCharCode(0x02);

export function HighlightedSnippet({ text }: { text: string }) {
	const parts = useMemo(() => parseSnippet(text), [text]);
	return (
		<>
			{parts.map((p, i) =>
				p.mark ? (
					<mark
						key={i}
						className="bg-amber-200/70 dark:bg-amber-500/30 text-ink-900 dark:text-ink-100 rounded px-0.5"
					>
						{p.text}
					</mark>
				) : (
					<span key={i}>{p.text}</span>
				),
			)}
		</>
	);
}

function parseSnippet(text: string): { mark: boolean; text: string }[] {
	const out: { mark: boolean; text: string }[] = [];
	let i = 0;
	while (i < text.length) {
		const start = text.indexOf(MARK_START, i);
		if (start === -1) {
			out.push({ mark: false, text: text.slice(i) });
			break;
		}
		if (start > i) out.push({ mark: false, text: text.slice(i, start) });
		const end = text.indexOf(MARK_END, start + 1);
		if (end === -1) {
			// Unterminated — treat the rest as plain text.
			out.push({ mark: false, text: text.slice(start + 1) });
			break;
		}
		out.push({ mark: true, text: text.slice(start + 1, end) });
		i = end + 1;
	}
	return out;
}

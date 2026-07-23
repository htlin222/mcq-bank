import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronRight } from "lucide-react";
import type { LectureDoc } from "../../lib/lectureApi";
import {
	WINTROBE_TOC,
	chapterNumFromSlug,
	type WintrobePart,
} from "../../lib/wintrobeToc";

// Browse the Wintrobe textbook by the book's own Part → Section → chapter
// structure (see wintrobeToc.ts), as a nested accordion. Chapters missing from
// `docs` (not imported) are simply skipped so counts reflect what's readable.

export function TextbookToc({ docs }: { docs: LectureDoc[] }) {
	// chapter number → its lecture_docs row, for O(1) lookup while grouping.
	const byNum = useMemo(() => {
		const m = new Map<number, LectureDoc>();
		for (const d of docs) {
			const n = chapterNumFromSlug(d.slug);
			if (n != null) m.set(n, d);
		}
		return m;
	}, [docs]);

	// Open the first part by default so the view isn't a wall of closed rows.
	const [openParts, setOpenParts] = useState<Set<number>>(() => new Set([1]));

	const toggle = (n: number) =>
		setOpenParts((prev) => {
			const next = new Set(prev);
			next.has(n) ? next.delete(n) : next.add(n);
			return next;
		});

	return (
		<div className="space-y-2">
			{WINTROBE_TOC.map((part) => (
				<PartRow
					key={part.n}
					part={part}
					byNum={byNum}
					open={openParts.has(part.n)}
					onToggle={() => toggle(part.n)}
				/>
			))}
		</div>
	);
}

function countPresent(part: WintrobePart, byNum: Map<number, LectureDoc>): number {
	let n = 0;
	for (const s of part.sections)
		for (const c of s.chapters) if (byNum.has(c)) n++;
	return n;
}

function PartRow({
	part,
	byNum,
	open,
	onToggle,
}: {
	part: WintrobePart;
	byNum: Map<number, LectureDoc>;
	open: boolean;
	onToggle: () => void;
}) {
	const total = countPresent(part, byNum);
	return (
		<div className="border border-ink-200 dark:border-ink-700 rounded-lg overflow-hidden bg-white dark:bg-ink-800">
			<button
				type="button"
				onClick={onToggle}
				aria-expanded={open}
				className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-ink-50 dark:hover:bg-ink-700/50 transition"
			>
				<ChevronRight
					size={18}
					className={
						"shrink-0 text-ink-400 dark:text-ink-500 transition-transform " +
						(open ? "rotate-90" : "")
					}
					aria-hidden="true"
				/>
				<span className="text-xs font-mono text-accent shrink-0">
					Part {part.n}
				</span>
				<h2 className="font-serif text-lg leading-snug text-ink-900 dark:text-ink-100">
					{part.title}
				</h2>
				<span className="ml-auto text-xs text-ink-400 dark:text-ink-500 shrink-0">
					{total} 章
				</span>
			</button>

			{open && (
				<div className="border-t border-ink-100 dark:border-ink-700 px-4 py-3 space-y-4">
					{part.sections.map((s, i) => (
						<SectionBlock
							key={s.title || `flat-${i}`}
							title={s.title}
							chapters={s.chapters}
							byNum={byNum}
						/>
					))}
				</div>
			)}
		</div>
	);
}

function SectionBlock({
	title,
	chapters,
	byNum,
}: {
	title: string;
	chapters: number[];
	byNum: Map<number, LectureDoc>;
}) {
	const present = chapters.filter((c) => byNum.has(c));
	if (present.length === 0) return null;
	return (
		<div>
			{title && (
				<h3 className="text-xs font-semibold uppercase tracking-wide text-ink-500 dark:text-ink-400 mb-2">
					{title}
				</h3>
			)}
			<ul className="grid gap-1.5 sm:grid-cols-2">
				{present.map((c) => (
					<ChapterRow key={c} n={c} doc={byNum.get(c)!} />
				))}
			</ul>
		</div>
	);
}

function ChapterRow({ n, doc }: { n: number; doc: LectureDoc }) {
	// doc.title is "Wintrobe Ch76 · <chapter title>" — drop the "Wintrobe " prefix
	// (the Part context already makes the book clear) so "Ch76 · …" leads.
	const label = doc.title.replace(/^Wintrobe\s+/, "");
	return (
		<li>
			<Link
				to={`/lectures/${doc.slug}`}
				className="group flex items-baseline gap-2 rounded px-2 py-1.5 hover:bg-ink-50 dark:hover:bg-ink-700/50 transition"
			>
				<span className="font-mono text-xs text-ink-400 dark:text-ink-500 shrink-0 w-10">
					Ch{n}
				</span>
				<span className="text-sm text-ink-800 dark:text-ink-200 group-hover:text-accent transition leading-snug">
					{label.replace(/^Ch\d+\s*·\s*/, "")}
				</span>
				<span className="ml-auto text-xs text-ink-300 dark:text-ink-600 shrink-0">
					{doc.page_count}p
				</span>
			</Link>
		</li>
	);
}

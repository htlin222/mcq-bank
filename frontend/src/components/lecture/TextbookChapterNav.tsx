import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { listLectures, type LectureDoc } from "../../lib/lectureApi";
import { chapterNumFromSlug } from "../../lib/wintrobeToc";
import { TextbookToc } from "./TextbookToc";

// Textbook reader title that doubles as a chapter switcher: click it to drop
// down the same nested Part → Section → chapter accordion used on /lectures,
// with the current chapter highlighted and its part pre-opened. Picking a
// chapter navigates the reader (the accordion rows are plain <Link>s).
export function TextbookChapterNav({
	title,
	slug,
}: {
	title: string;
	slug: string;
}) {
	const [open, setOpen] = useState(false);
	const [docs, setDocs] = useState<LectureDoc[] | null>(null);
	const rootRef = useRef<HTMLDivElement>(null);
	const current = chapterNumFromSlug(slug) ?? undefined;

	// Lazy-load the textbook list the first time the switcher opens.
	useEffect(() => {
		if (!open || docs) return;
		let alive = true;
		listLectures("textbook")
			.then((d) => alive && setDocs(d))
			.catch(() => alive && setDocs([]));
		return () => {
			alive = false;
		};
	}, [open, docs]);

	// Dismiss on outside-click / Esc.
	useEffect(() => {
		if (!open) return;
		const onDown = (e: MouseEvent) => {
			if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
				setOpen(false);
			}
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") setOpen(false);
		};
		document.addEventListener("mousedown", onDown);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("mousedown", onDown);
			document.removeEventListener("keydown", onKey);
		};
	}, [open]);

	// "Wintrobe Ch1 · …" → "Ch1 · …" (the drawer makes the book obvious).
	const label = title.replace(/^Wintrobe\s+/, "");

	return (
		<div ref={rootRef} className="relative min-w-0 shrink">
			<button
				type="button"
				onClick={() => setOpen((o) => !o)}
				aria-expanded={open}
				title="切換章節"
				className="flex min-w-0 max-w-full items-center gap-1.5 rounded px-1 -mx-1 transition hover:bg-ink-100 dark:hover:bg-ink-700/50"
			>
				<h1 className="truncate font-serif text-lg text-ink-900 dark:text-ink-100">
					{label}
				</h1>
				<ChevronDown
					size={16}
					className={
						"shrink-0 text-ink-400 transition-transform dark:text-ink-500 " +
						(open ? "rotate-180" : "")
					}
					aria-hidden="true"
				/>
			</button>

			{open && (
				<div className="absolute left-0 top-full z-40 mt-1 max-h-[70vh] w-[min(92vw,42rem)] overflow-y-auto rounded-lg border border-ink-200 bg-white p-2 shadow-paper dark:border-ink-700 dark:bg-ink-900">
					{docs === null ? (
						<p className="p-4 text-sm text-ink-400 dark:text-ink-500">
							載入章節…
						</p>
					) : (
						<TextbookToc
							docs={docs}
							currentChapter={current}
							onNavigate={() => setOpen(false)}
						/>
					)}
				</div>
			)}
		</div>
	);
}

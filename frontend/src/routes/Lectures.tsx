import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Highlighter, NotebookPen } from "lucide-react";
import { listLectures, type LectureDoc } from "../lib/lectureApi";

export default function Lectures() {
	const [docs, setDocs] = useState<LectureDoc[] | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let alive = true;
		listLectures()
			.then((d) => {
				if (alive) setDocs(d);
			})
			.catch((e) => {
				if (alive) setError(e?.message || "載入失敗");
			});
		return () => {
			alive = false;
		};
	}, []);

	return (
		<div className="max-w-5xl lg:max-w-6xl xl:max-w-7xl mx-auto px-4 sm:px-6 py-8">
			<h1 className="font-serif text-3xl text-ink-900 dark:text-ink-100 mb-6">
				複習班講義
			</h1>

			{error ? (
				<p className="text-rose-600 dark:text-rose-400 text-sm">
					無法載入講義：{error}
				</p>
			) : docs === null ? (
				<div className="text-ink-400 dark:text-ink-500 text-sm">載入中…</div>
			) : docs.length === 0 ? (
				<p className="text-ink-400 dark:text-ink-500 text-sm">
					目前還沒有任何講義。
				</p>
			) : (
				<div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
					{docs.map((d) => (
						<LectureCard key={d.slug} doc={d} />
					))}
				</div>
			)}
		</div>
	);
}

function LectureCard({ doc }: { doc: LectureDoc }) {
	return (
		<Link
			to={`/lectures/${doc.slug}`}
			className="group flex flex-col bg-white dark:bg-ink-800 border border-ink-200 dark:border-ink-700 rounded-lg p-4 hover:border-accent transition"
		>
			<h2 className="font-serif text-lg leading-snug text-ink-900 dark:text-ink-100 group-hover:text-accent transition">
				{doc.title}
			</h2>
			{doc.instructor && (
				<p className="mt-1 text-sm text-ink-500 dark:text-ink-400">
					{doc.instructor}
				</p>
			)}
			<div className="mt-auto pt-4 flex items-center gap-2 text-xs text-ink-400 dark:text-ink-500">
				<span>{doc.page_count} 頁</span>
				{doc.anno_count > 0 && (
					<span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300">
						<Highlighter size={12} />
						{doc.anno_count}
					</span>
				)}
				{doc.note_count > 0 && (
					<span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-accent/10 text-accent">
						<NotebookPen size={12} />
						{doc.note_count}
					</span>
				)}
			</div>
		</Link>
	);
}

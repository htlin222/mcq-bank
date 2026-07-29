import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { BookOpen, GraduationCap, Loader2, Sparkles } from "lucide-react";
import {
	lookupReference,
	type ReferenceHit,
	type ReferenceResult,
} from "../../lib/textbookApi";
import { HighlightedSnippet } from "../lecture/HighlightedSnippet";

// 工具列「📖 查參考資料」展開後的內容:選取文字在 Wintrobe 教科書與複習班講義
// 裡最相關的段落。原本是 TextbookLookupPopup 自帶的浮層,現在只是統一工具列
// 的一個展開區。

// "Wintrobe Ch92 · Chronic Lymphocytic Leukemia" → "Ch92 · Chronic …"
function chapterLabel(title: string): string {
	return title.replace(/^Wintrobe\s+/, "");
}

export function ReferencePanel({
	text,
	onNavigate,
}: {
	text: string;
	onNavigate: () => void;
}) {
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState(false);
	const [result, setResult] = useState<ReferenceResult | null>(null);

	// 展開即查 —— 這個面板只有在使用者按下按鈕後才掛載,不會有多餘的請求。
	useEffect(() => {
		let alive = true;
		setLoading(true);
		setError(false);
		lookupReference(text, 5)
			.then((r) => alive && setResult(r))
			.catch(() => alive && setError(true))
			.finally(() => alive && setLoading(false));
		return () => {
			alive = false;
		};
	}, [text]);

	const empty =
		result && result.textbook.length === 0 && result.lecture.length === 0;

	return (
		// 高度由工具列依「選取上/下方還剩多少視窗」給,這裡只負責在裡面捲。
		<div className="min-h-0 overflow-y-auto">
			{loading && (
				<div className="flex items-center gap-2 px-3 py-4 text-sm text-ink-500">
					<Loader2 size={15} className="animate-spin" />
					搜尋教科書與講義…
				</div>
			)}

			{!loading && error && (
				<div className="px-3 py-4 text-sm text-red-600 dark:text-red-400">
					查詢失敗,請稍後再試。
				</div>
			)}

			{!loading && !error && empty && (
				<div className="px-3 py-4 text-sm text-ink-500 dark:text-ink-400">
					教科書與講義中找不到相關段落。
				</div>
			)}

			{!loading && !error && result && !empty && (
				<div className="divide-y divide-ink-100 dark:divide-ink-700">
					{result.refined && (
						<div className="flex items-center gap-1 px-3 py-1.5 text-[11px] text-ink-400 dark:text-ink-500">
							<Sparkles size={11} />
							已用 AI 精煉查詢
						</div>
					)}
					{result.textbook.length > 0 && (
						<ReferenceGroup
							icon={<BookOpen size={13} />}
							label="Wintrobe 教科書"
							hits={result.textbook}
							labelOf={(h) => chapterLabel(h.title)}
							onNavigate={onNavigate}
						/>
					)}
					{result.lecture.length > 0 && (
						<ReferenceGroup
							icon={<GraduationCap size={13} />}
							label="複習班講義"
							hits={result.lecture}
							labelOf={(h) => h.title}
							onNavigate={onNavigate}
						/>
					)}
				</div>
			)}
		</div>
	);
}

function ReferenceGroup({
	icon,
	label,
	hits,
	labelOf,
	onNavigate,
}: {
	icon: React.ReactNode;
	label: string;
	hits: ReferenceHit[];
	labelOf: (h: ReferenceHit) => string;
	onNavigate: () => void;
}) {
	const top = hits[0];
	return (
		<div className="px-3 py-2.5">
			<div className="flex items-center gap-1.5 mb-1.5 text-xs font-medium text-ink-500 dark:text-ink-400">
				{icon}
				{label}
			</div>

			{/* Layer 1 — snippet glance of the top hit, zero navigation / zero load */}
			<div className="text-[13px] leading-relaxed text-ink-800 dark:text-ink-200">
				<HighlightedSnippet text={top.snippet} />
			</div>

			{/* Layer 3 — real <a> deep-links (Cmd/Ctrl-click = new tab) */}
			<div className="mt-2 space-y-0.5">
				{hits.slice(0, 3).map((h) => (
					<Link
						key={`${h.slug}:${h.page}`}
						to={`/lectures/${h.slug}?page=${h.page}`}
						onClick={(e) => {
							if (!e.metaKey && !e.ctrlKey) onNavigate();
						}}
						className="flex items-center justify-between gap-2 px-1.5 py-1 rounded text-xs text-ink-600 dark:text-ink-300 hover:bg-ink-50 dark:hover:bg-ink-700/60 transition"
					>
						<span className="truncate">{labelOf(h)}</span>
						<span className="shrink-0 tabular-nums text-ink-400">
							p.{h.page}
						</span>
					</Link>
				))}
			</div>
		</div>
	);
}

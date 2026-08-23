// 左側 rail 的「書籤」分頁 —— 這一份講義的書籤,依頁碼排。
//
// 拿來當目錄用的,所以排序是頁碼而不是加入時間:依時間排會讓同一份講義的
// 書籤在頁碼上跳來跳去,而使用者在 rail 上找的是「我標過的那一頁在哪」。
import { Bookmark, X } from "lucide-react";
import type { LectureBookmark } from "../../lib/lectureApi";

export function BookmarkRailPane({
	bookmarks,
	loading,
	currentPage,
	onJump,
	onRemove,
}: {
	bookmarks: LectureBookmark[];
	loading: boolean;
	/** 1-based,用來標出「現在就在這一頁」。 */
	currentPage: number;
	/** @param page 1-based */
	onJump(page: number): void;
	/** @param page 1-based */
	onRemove(page: number): void;
}) {
	if (loading) {
		return (
			<p className="px-2 py-3 text-xs text-ink-400 dark:text-ink-500">載入中…</p>
		);
	}
	if (bookmarks.length === 0) {
		return (
			<p className="px-2 py-3 text-xs leading-relaxed text-ink-400 dark:text-ink-500">
				還沒有書籤。在工具列按
				<Bookmark size={12} className="mx-1 inline align-[-1px]" />
				可以把現在這一頁記下來。
			</p>
		);
	}
	return (
		<ul className="py-1">
			{bookmarks.map((b) => (
				<li key={b.id} className="group relative">
					<button
						type="button"
						onClick={() => onJump(b.page)}
						className={
							"block w-full px-2 py-1.5 pr-6 text-left transition " +
							(b.page === currentPage
								? "bg-accent/10"
								: "hover:bg-ink-50 dark:hover:bg-ink-800")
						}
					>
						<span
							className={
								"font-mono text-[11px] " +
								(b.page === currentPage
									? "font-medium text-accent"
									: "text-ink-500 dark:text-ink-400")
							}
						>
							p.{b.page}
						</span>
						{b.note_preview && (
							<span className="mt-0.5 block line-clamp-2 text-[11px] leading-snug text-ink-600 dark:text-ink-300">
								{b.note_preview}
							</span>
						)}
					</button>
					{/* 移除鈕在 hover 才出現,但鍵盤永遠到得了(focus-within 也顯示)。
					    只靠 hover 的話,用鍵盤操作的人完全刪不掉書籤。 */}
					<button
						type="button"
						onClick={() => onRemove(b.page)}
						aria-label={`移除第 ${b.page} 頁的書籤`}
						title="移除書籤"
						className="absolute right-1 top-1 rounded p-0.5 text-ink-400 opacity-0 transition hover:bg-ink-100 hover:text-rose-600 focus:opacity-100 group-hover:opacity-100 dark:text-ink-500 dark:hover:bg-ink-700"
					>
						<X size={12} />
					</button>
				</li>
			))}
		</ul>
	);
}

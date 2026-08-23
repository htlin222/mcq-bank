// 單一講義的書籤(migration 0042)。掛載時載入一次,之後樂觀更新 + 失敗回滾。
//
// 頁碼一律 1-based —— 跟 lecture_notes 一致(卡片預覽就是 join 它)。呼叫端
// (LectureReader)手上是 viewer 的 0-based currentPage,轉換只發生在那一處。
import { useCallback, useEffect, useState } from "react";
import {
	listBookmarks,
	addBookmark as apiAdd,
	removeBookmark as apiRemove,
	type LectureBookmark,
} from "../lib/lectureApi";

export interface UseLectureBookmarks {
	bookmarks: LectureBookmark[];
	loading: boolean;
	error: string | null;
	/** @param page 1-based */
	has(page: number): boolean;
	/** 加或移除 `page`(1-based)。回傳切換後的狀態。 */
	toggle(page: number): Promise<boolean>;
	/** @param page 1-based */
	remove(page: number): Promise<void>;
}

function byPage(a: LectureBookmark, b: LectureBookmark) {
	return a.page - b.page;
}

export function useLectureBookmarks(slug: string): UseLectureBookmarks {
	const [bookmarks, setBookmarks] = useState<LectureBookmark[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let alive = true;
		setLoading(true);
		setBookmarks([]);
		listBookmarks(slug)
			.then((rows) => {
				if (alive) {
					setBookmarks([...rows].sort(byPage));
					setError(null);
				}
			})
			.catch((e) => {
				if (alive) setError(e?.message || "載入書籤失敗");
			})
			.finally(() => {
				if (alive) setLoading(false);
			});
		return () => {
			alive = false;
		};
	}, [slug]);

	const has = useCallback(
		(page: number) => bookmarks.some((b) => b.page === page),
		[bookmarks],
	);

	const remove = useCallback(
		async (page: number) => {
			const before = bookmarks;
			setBookmarks(before.filter((b) => b.page !== page));
			try {
				await apiRemove(slug, page);
			} catch (e: any) {
				setBookmarks(before); // 回滾 —— 否則畫面說刪掉了,重整又回來
				setError(e?.message || "移除書籤失敗");
				throw e;
			}
		},
		[bookmarks, slug],
	);

	const toggle = useCallback(
		async (page: number) => {
			if (bookmarks.some((b) => b.page === page)) {
				await remove(page);
				return false;
			}
			const before = bookmarks;
			// 樂觀列的 id 用 `pending:` 前綴,伺服器回來就整列換掉。看得出是暫時的,
			// 而且不會跟真的 UUID 撞。
			const optimistic: LectureBookmark = {
				id: `pending:${page}`,
				slug,
				page,
				created_at: Date.now(),
				title: "",
				instructor: "",
				sort_order: 0,
				note_preview: "",
			};
			setBookmarks([...before, optimistic].sort(byPage));
			try {
				const row = await apiAdd(slug, page);
				setBookmarks((prev) =>
					prev.map((b) => (b.id === optimistic.id ? row : b)).sort(byPage),
				);
				return true;
			} catch (e: any) {
				setBookmarks(before);
				setError(e?.message || "加入書籤失敗");
				throw e;
			}
		},
		[bookmarks, remove, slug],
	);

	return { bookmarks, loading, error, has, toggle, remove };
}

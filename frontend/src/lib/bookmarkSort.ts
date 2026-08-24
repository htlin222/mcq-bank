// 講義書籤的排序與過濾。純函式,沒有 import —— 所以在 `node --test` 底下
// 載得起來(同 autoHideChrome.ts / reorder.ts 那條)。

export interface SortableBookmark {
	slug: string;
	page: number;
	created_at: number;
	title: string;
	sort_order: number;
	note_preview: string;
}

/** 日期(新→舊)或依文件(講義排序 → 頁碼)。 */
export type BookmarkSort = "date" | "doc";

/**
 * 兩種排序都做到「全序」—— 每一條比較都有最終的決勝鍵。
 *
 * 這不是龜毛:`created_at` 是毫秒,同一秒內連加兩個書籤(在 rail 上一路往下
 * 標)就會撞;`sort_order` 更是整份講義共用同一個值。同分時交給 `sort` 自由
 * 決定的話,使用者看到的是「每次重整卡片就換位置」,而且在只有兩三個書籤的
 * 帳號上完全看不出來。決勝鍵一路排到 (slug, page),那組合是唯一的
 * (migration 0042 的 UNIQUE 保證)。
 */
export function sortBookmarks<T extends SortableBookmark>(
	rows: readonly T[],
	mode: BookmarkSort,
): T[] {
	const out = [...rows];
	if (mode === "date") {
		out.sort(
			(a, b) =>
				b.created_at - a.created_at ||
				a.slug.localeCompare(b.slug) ||
				a.page - b.page,
		);
	} else {
		out.sort(
			(a, b) =>
				a.sort_order - b.sort_order ||
				a.slug.localeCompare(b.slug) ||
				a.page - b.page,
		);
	}
	return out;
}

/**
 * 前端就地過濾(同「其他筆記」那個分頁):標題或筆記預覽命中即可。
 *
 * 預覽只有前 240 字,所以長筆記的深處搜不到 —— 刻意的取捨,換到的是零延遲與
 * 零索引。要搜內文有 /lectures 既有的「筆記」搜尋範圍。
 */
export function matchesBookmark(b: SortableBookmark, q: string): boolean {
	const needle = q.trim().toLowerCase();
	if (!needle) return true;
	return (
		b.title.toLowerCase().includes(needle) ||
		b.note_preview.toLowerCase().includes(needle)
	);
}

// 講義閱讀器網址上的 `?page=`。
//
// 讀與寫共用這一份定義。分開寫的話遲早會對不上 —— 例如讀的時候接受 `0`、
// 寫的時候從 `1` 起算,使用者就會看到「複製出去的連結跳到別頁」。
//
// 對外一律是 **1-based**(跟 PDF 上印的頁碼、跟搜尋結果回傳的 `hit.page` 一致);
// 對內的 viewer API 是 0-indexed,轉換只發生在這裡。

/** 網址上的字串 → 0-indexed 頁。看不懂就回 null(不猜、不夾)。 */
export function readPageParam(raw: string | null): number | null {
	if (!raw) return null;
	const n = Number.parseInt(raw, 10);
	if (!Number.isFinite(n) || n < 1) return null;
	return n - 1;
}

/**
 * 0-indexed 頁 → 網址上該有的值。第一頁回 `null`(不寫參數)。
 *
 * 第一頁不寫,是因為剛打開講義的網址不該立刻多長出一截 `?page=1`;而分享
 * 第一頁的連結不帶參數本來就會落在第一頁,沒有資訊損失。
 */
export function pageParamFor(pageIndex: number): string | null {
	return pageIndex > 0 ? String(pageIndex + 1) : null;
}

/**
 * 算出新的 query string。**沒有變化時回 `null`**,呼叫端據此完全跳過寫入。
 *
 * 這個「沒變就不寫」不是省效能:寫入會讓 `searchParams` 換新物件,而同步的
 * effect 依賴它 —— 少了這道閘就是無窮迴圈。Safari 另外對 `replaceState`
 * 有每 30 秒 100 次的上限,連續翻頁時也靠它擋掉大部分寫入。
 *
 * 其他既有參數原樣保留(講義搜尋、之後可能加的東西都在同一條網址上)。
 */
export function nextPageSearch(
	current: URLSearchParams,
	pageIndex: number,
): URLSearchParams | null {
	const want = pageParamFor(pageIndex);
	if (want === (current.get("page") ?? null)) return null;
	const next = new URLSearchParams(current);
	if (want === null) next.delete("page");
	else next.set("page", want);
	return next;
}

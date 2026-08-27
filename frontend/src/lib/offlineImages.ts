// 離線預載的第二期:圖片。
// 設計:docs/plans/2026-08-27-offline-year-prefetch-design.md 的最後一節。
//
// 這個檔案**不 import 任何東西** —— 純函式才進得了 `pnpm test`(node --test)。
//
// 跟文字那一期最大的差別是**量級**:一年的文字是 160–410 KB,圖片是 8–17 MB,
// 差 40 倍。所以文字可以自動在背景拓,圖片一定要是一顆使用者按下去的按鈕,而且
// 按鈕上要先寫出數字。

/** ProseMirror / TipTap 的節點,只取這裡用得到的部分。 */
type PMNode = { type?: string; attrs?: Record<string, unknown>; content?: PMNode[] };

/**
 * 一張圖實測的平均大小(bytes)。
 *
 * **這個數字是量出來的,不是估的**:2026-08-27 從 R2 隨機抽 10 張詳解裡的圖,
 * 大小從 18.7 KB 到 147 KB,平均 66 KB。改動這個常數之前請重新抽樣 —— 它唯一的
 * 用途是讓按鈕上寫得出「約 12 MB」,而一個亂寫的數字比不寫更糟(使用者會照著它
 * 決定要不要在行動網路上按下去)。
 */
export const AVG_IMAGE_BYTES = 66_000;

/**
 * 從一份 TipTap 文件裡撈出站內圖片的 URL(`/img/<key>`)。
 *
 * 外部 http(s) 圖片不收:它們不經過我們的 Worker,也不在 `img-v1` 那條快取路由上,
 * 抓了也只是浪費頻寬。帶 `..` 的一律拒絕 —— 同 `worker/routes/images.ts` 與
 * `worker/lib/export-images.ts` 的姿態,而且 `content_json` 是使用者可寫的欄位。
 */
export function collectImageSrcs(doc: unknown): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	const visit = (n: unknown) => {
		if (!n || typeof n !== "object") return;
		const node = n as PMNode;
		if (node.type === "image") {
			const src = node.attrs?.src;
			if (typeof src === "string" && src.startsWith("/img/")) {
				const key = src.slice("/img/".length);
				if (key && !key.split("/").includes("..") && !seen.has(src)) {
					seen.add(src);
					out.push(src);
				}
			}
		}
		if (Array.isArray(node.content)) for (const c of node.content) visit(c);
	};
	visit(doc);
	return out;
}

/**
 * 把一份題目 payload 裡所有會被畫出來的站內圖撈出來。
 *
 * **只看共筆詳解,不看個人筆記。** 筆記是私人的,而且它的圖多半是使用者自己貼的
 * 截圖 —— 離線要不要帶那些是另一個問題(而且量沒有邊界)。共筆詳解才是「這一年的
 * 教材」,也是離線讀的時候真正會看的東西。
 */
export function imagesInQuestionPayload(payload: unknown): string[] {
	if (!payload || typeof payload !== "object") return [];
	const exp = (payload as { explanation?: { content_json?: unknown } })
		.explanation;
	if (!exp || typeof exp !== "object") return [];
	const raw = (exp as { content_json?: unknown }).content_json;
	if (typeof raw !== "string") return [];
	let doc: unknown;
	try {
		doc = JSON.parse(raw);
	} catch {
		// 壞掉的 JSON 就當成沒有圖 —— 這一層只是預載,不該因為某一題的資料有問題
		// 就讓整批停下來。
		return [];
	}
	return collectImageSrcs(doc);
}

/** 給按鈕用的一句話:「約 148 張 · 約 9.8 MB」。 */
export function describeImageCost(count: number): string {
	const mb = (count * AVG_IMAGE_BYTES) / 1024 / 1024;
	// 小數點一位就夠。整數會讓 0.4 MB 顯示成「約 0 MB」,看起來像壞掉。
	return `約 ${count} 張 · 約 ${mb.toFixed(1)} MB`;
}

/**
 * 空間夠不夠。`estimate()` 在部分瀏覽器沒有,拿不到就一律放行 —— 擋下一個其實
 * 空間充足的裝置,比讓它試著抓然後被瀏覽器拒絕更糟(後者至少會失敗得很明確)。
 *
 * 留三倍餘裕:平均值只是平均,而配額用滿的後果是**整個站的快取被清掉**,
 * 不只是這一批圖。
 */
export function hasRoomFor(
	count: number,
	quota: { usage?: number; quota?: number } | null,
): boolean {
	if (!quota || typeof quota.quota !== "number") return true;
	const free = quota.quota - (quota.usage ?? 0);
	return free > count * AVG_IMAGE_BYTES * 3;
}

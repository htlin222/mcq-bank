// 核准投稿時,檢視圖與全螢幕圖必須是兩把不同的 R2 key,而且檢視圖的位元組
// 要明顯小於原檔。縮圖在瀏覽器做(見 frontend/src/lib/smearViewImage.ts 的
// 同一條 80% 門檻):Workers 免費方案一次請求只有 10ms CPU,解一張抹片會
// 超;Images binding 過了每月 5,000 次唯一轉換就要計費,而且得新增 binding。
// 這支只決定「能不能寫、寫到哪一把 key」,不碰 R2。

/** 檢視圖位元組 ≤ 原圖的 80% 才算「明顯更小」。剛好 80% 過,多 1 byte 不過。 */
export function viewIsClearlySmaller(viewBytes: number, fullBytes: number): boolean {
	if (!Number.isFinite(viewBytes) || !Number.isFinite(fullBytes)) return false;
	if (viewBytes < 1 || fullBytes < 1) return false;
	return viewBytes * 5 <= fullBytes * 4;
}

/** `smear/submissions/<id>-view.<ext>`。id 進路徑,所以拒絕斜線與 `..`。 */
export function submissionViewKey(submissionId: string, contentType: string): string | null {
	if (!submissionId || submissionId.includes("/") || submissionId.includes("..")) return null;
	const ext =
		contentType === "image/jpeg"
			? "jpg"
			: contentType === "image/png"
				? "png"
				: contentType === "image/webp"
					? "webp"
					: contentType === "image/gif"
						? "gif"
						: null;
	if (!ext) return null;
	return `smear/submissions/${submissionId}-view.${ext}`;
}

export function planApprovedImages(input: {
	submissionId: string;
	fullKey: string;
	viewType: string;
	viewBytes: number;
	fullBytes: number;
}): { ok: true; viewKey: string; fullKey: string } | { ok: false; error: string } {
	const viewKey = submissionViewKey(input.submissionId, input.viewType);
	if (!viewKey) return { ok: false, error: "view image type is not allowed" };
	if (!input.fullKey || viewKey === input.fullKey) {
		return { ok: false, error: "view key collides with the original" };
	}
	if (!viewIsClearlySmaller(input.viewBytes, input.fullBytes)) {
		return { ok: false, error: "view image must be clearly smaller than the original" };
	}
	return { ok: true, viewKey, fullKey: input.fullKey };
}

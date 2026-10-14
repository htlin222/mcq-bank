// 核准投稿時在瀏覽器把原圖縮成檢視圖。門檻跟 worker/lib/smear-approve-images.ts
// 的 viewIsClearlySmaller 是同一條:檢視圖位元組 ≤ 原圖的 80%。改一邊要改另一邊,
// 兩邊的測試都釘著 800/1000 過、801/1000 不過。
//
// 不在 Worker 裡縮。免費方案一次請求 10ms CPU,解一張抹片會超;Images binding
// 每月 5,000 次唯一轉換之後要計費,還得加一個 binding。核准是管理員按一下,
// 瀏覽器本來就有這張圖。

export const SMEAR_VIEW_MAX_LONG_EDGE = 1280;
export const SMEAR_VIEW_JPEG_QUALITY = 0.72;

/** 檢視圖位元組 ≤ 原圖的 80%。剛好 80% 過,多 1 byte 不過。 */
export function viewIsClearlySmaller(viewBytes: number, fullBytes: number): boolean {
	if (!Number.isFinite(viewBytes) || !Number.isFinite(fullBytes)) return false;
	if (viewBytes < 1 || fullBytes < 1) return false;
	return viewBytes * 5 <= fullBytes * 4;
}

/**
 * 長邊超過 1280 就收到 1280;否則收到 75%,所以已經不大的原圖也會變小,
 * 不會重壓出一張跟原檔一樣大的 JPEG。
 */
export function smearViewPixelSize(
	width: number,
	height: number,
): { width: number; height: number } | null {
	if (!(width >= 1) || !(height >= 1)) return null;
	const long = Math.max(width, height);
	const cap =
		long > SMEAR_VIEW_MAX_LONG_EDGE
			? SMEAR_VIEW_MAX_LONG_EDGE
			: Math.max(1, Math.floor((long * 3) / 4));
	const scale = cap / long;
	return {
		width: Math.max(1, Math.round(width * scale)),
		height: Math.max(1, Math.round(height * scale)),
	};
}

function drawJpeg(
	source: CanvasImageSource,
	size: { width: number; height: number },
	quality: number,
): Promise<Blob> {
	const canvas = document.createElement("canvas");
	canvas.width = size.width;
	canvas.height = size.height;
	const ctx = canvas.getContext("2d");
	if (!ctx) return Promise.reject(new Error("無法建立畫布"));
	ctx.drawImage(source, 0, 0, size.width, size.height);
	return new Promise((resolve, reject) => {
		canvas.toBlob(
			(blob) => (blob ? resolve(blob) : reject(new Error("檢視圖沒有編碼出來"))),
			"image/jpeg",
			quality,
		);
	});
}

/** 產出一張明顯比 `sourceBytes` 小的 JPEG。縮了還不夠小就再降畫質、再對半。 */
export async function encodeSmearView(source: ImageBitmap, sourceBytes: number): Promise<Blob> {
	const first = smearViewPixelSize(source.width, source.height);
	if (!first) throw new Error("原圖沒有像素");
	let blob = await drawJpeg(source, first, SMEAR_VIEW_JPEG_QUALITY);
	if (!viewIsClearlySmaller(blob.size, sourceBytes)) {
		blob = await drawJpeg(source, first, 0.55);
	}
	if (!viewIsClearlySmaller(blob.size, sourceBytes)) {
		const half = smearViewPixelSize(
			Math.max(1, Math.floor(source.width / 2)),
			Math.max(1, Math.floor(source.height / 2)),
		);
		if (half) blob = await drawJpeg(source, half, 0.6);
	}
	if (!viewIsClearlySmaller(blob.size, sourceBytes)) {
		throw new Error("檢視圖沒有比原圖小");
	}
	return blob;
}

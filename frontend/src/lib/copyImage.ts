// 複製圖片到剪貼簿 —— 給 SmearImage.tsx 用(抹片練習/診斷詳情頁的影像)。
//
// ⚠️ iOS Safari 要求 `navigator.clipboard.write()` 必須在使用者手勢的呼叫堆疊
// 「同步」呼叫,不能等一個 `await`(例如先 `await fetch()` 拿到 blob)之後才
// 呼叫 —— 那個 await 讓瀏覽器判定手勢已經結束,write() 會被靜靜拒絕。
// `ClipboardItem` 的每個 mime 值可以是 `Promise<Blob>`,所以正確做法是:
// 同步建構 `ClipboardItem`(值是還沒 resolve 的 promise)、同步呼叫
// `clipboard.write()`,圖片的下載/轉檔全部在那個 promise 背後非同步進行。
// 這裡的 `copyImageToClipboard()` 因此刻意不是 `async function`,呼叫端也
// 不能在呼叫它之前 `await` 任何東西。
//
// 一律轉成 PNG 再寫入,不管來源格式是什麼(這裡的來源是 webp)——
// `ClipboardItem` 的 spec 要求 promise resolve 出來的 Blob type 要跟宣告的
// key 完全一致,不然整個 write() 會 reject。PNG 是所有主要瀏覽器公認支援的
// 剪貼簿圖片格式,webp 的剪貼簿支援不穩定(尤其是 Safari)——與其賭來源格式
// 被接受,不如保證輸出格式一致。

export function supportsClipboardImageWrite(): boolean {
	return (
		typeof window !== "undefined" &&
		typeof (window as unknown as { ClipboardItem?: unknown }).ClipboardItem !==
			"undefined" &&
		typeof navigator !== "undefined" &&
		!!navigator.clipboard &&
		typeof navigator.clipboard.write === "function"
	);
}

async function fetchAsPngBlob(url: string): Promise<Blob> {
	const res = await fetch(url);
	if (!res.ok) throw new Error(`fetch ${url} failed: ${res.status}`);
	const srcBlob = await res.blob();
	const bitmap = await createImageBitmap(srcBlob);
	try {
		const canvas = document.createElement("canvas");
		canvas.width = bitmap.width;
		canvas.height = bitmap.height;
		const ctx = canvas.getContext("2d");
		if (!ctx) throw new Error("canvas 2d context unavailable");
		ctx.drawImage(bitmap, 0, 0);
		return await new Promise<Blob>((resolve, reject) => {
			canvas.toBlob(
				(b) => (b ? resolve(b) : reject(new Error("canvas.toBlob failed"))),
				"image/png",
			);
		});
	} finally {
		bitmap.close?.();
	}
}

/**
 * 複製圖片到剪貼簿。**必須在使用者手勢的同一個呼叫堆疊裡呼叫**——呼叫端的
 * onClick handler 不能在呼叫這個函式之前 `await` 任何東西,否則 iOS Safari
 * 會拒絕寫入(見檔頭說明)。
 *
 * 回傳的 promise resolve 代表複製成功;reject 代表失敗或不支援,呼叫端自行
 *決定要顯示什麼提示 —— 這裡不處理任何 UI。
 */
export function copyImageToClipboard(url: string): Promise<void> {
	if (!supportsClipboardImageWrite()) {
		return Promise.reject(new Error("clipboard image write unsupported"));
	}
	// 注意:`new ClipboardItem(...)` 與 `navigator.clipboard.write(...)` 都是
	// 同步呼叫,`fetchAsPngBlob(url)` 回傳的 promise 是原封不動塞進去的 ——
	// 中間沒有任何 `await`。
	const item = new ClipboardItem({ "image/png": fetchAsPngBlob(url) });
	return navigator.clipboard.write([item]);
}

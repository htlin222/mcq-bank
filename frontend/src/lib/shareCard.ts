// 圖卡怎麼交到使用者手上(#173)。
//
// 三條路,依環境挑一條:桌機進剪貼簿、手機走系統分享、都不支援就下載。

export type Delivery = "clipboard" | "share" | "download";

export type DeliveryEnv = {
	/** 觸控裝置。用來區分「手機」而不是靠 UA —— 桌機 Chrome 也有 navigator.share。 */
	coarsePointer: boolean;
	canShareFiles: boolean;
	canWriteImage: boolean;
};

/** 純函式,才測得到各種組合。 */
export function pickDelivery(env: DeliveryEnv): Delivery {
	if (env.coarsePointer && env.canShareFiles) return "share";
	if (env.canWriteImage) return "clipboard";
	// 桌機沒有剪貼簿圖片權限(Firefox 舊版)但有分享時,分享仍然勝過下載。
	if (env.canShareFiles) return "share";
	return "download";
}

export function readEnv(): DeliveryEnv {
	let canShareFiles = false;
	try {
		const probe = new File([new Blob()], "c.png", { type: "image/png" });
		canShareFiles = !!navigator.canShare?.({ files: [probe] });
	} catch {
		canShareFiles = false;
	}
	return {
		coarsePointer:
			typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches,
		canShareFiles,
		canWriteImage:
			typeof ClipboardItem !== "undefined" && typeof navigator.clipboard?.write === "function",
	};
}

/** 按鈕文案要跟著實際會發生的事走 —— 說「複製」卻跳出下載很像壞掉。 */
export function deliveryLabel(d: Delivery): string {
	if (d === "share") return "分享圖卡";
	if (d === "download") return "下載圖卡";
	return "複製成圖卡";
}

export function deliveryDoneLabel(d: Delivery): string {
	if (d === "share") return "已分享";
	if (d === "download") return "已下載";
	return "已複製";
}

function triggerDownload(blob: Blob, filename: string): void {
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = filename;
	document.body.appendChild(a);
	a.click();
	a.remove();
	// 立刻 revoke 會讓部分瀏覽器來不及讀 —— 下一個 tick 再收。
	setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * 送出圖卡。
 *
 * `png` 是**還沒 await 的 Promise**,這是刻意的:Safari 要求 `clipboard.write`
 * 在使用者手勢的同一個 task 裡呼叫,先 await 拿到 blob 再寫會丟
 * `NotAllowedError`。把非同步工作交給 `ClipboardItem` 自己等就沒事。
 * Chrome 兩種寫法都過,所以本機開發時發現不了 —— 不要「順手」改成先 await。
 */
export async function deliverCard(
	png: Promise<Blob>,
	filename: string,
	delivery: Delivery,
): Promise<Delivery> {
	if (delivery === "clipboard") {
		await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
		return "clipboard";
	}
	if (delivery === "share") {
		const blob = await png;
		const file = new File([blob], filename, { type: "image/png" });
		try {
			await navigator.share({ files: [file] });
			return "share";
		} catch (e) {
			// 使用者自己取消分享 —— 不是錯誤,也不該退回下載。
			if (e instanceof DOMException && e.name === "AbortError") throw e;
			// iOS 的分享同樣要求手勢,而我們必須先 await 才拿得到 File。
			// 逾時失去手勢時退回下載,總比什麼都沒發生好。
			triggerDownload(blob, filename);
			return "download";
		}
	}
	triggerDownload(await png, filename);
	return "download";
}

/** `血專-114-032-2026-08-21-1132.png` */
export function cardFilename(source: string, stamp: string): string {
	const slug = source.replace(/[^\w一-鿿-]+/g, "-").replace(/^-+|-+$/g, "");
	const time = stamp.replace(/[-: ]/g, "");
	return `${slug || "card"}-${time}.png`;
}

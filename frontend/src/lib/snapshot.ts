// Render a DOM node to a PNG and put it on the clipboard when the browser
// supports it, otherwise fall back to triggering a download. Exceptions
// (including the explicit 截圖失敗) propagate to the caller, which toasts.
import { toBlob } from "html-to-image";

export async function snapshotToClipboard(
	node: HTMLElement,
	filename = "slide.png",
): Promise<"clipboard" | "download"> {
	const blob = await toBlob(node, { pixelRatio: 2, cacheBust: true });
	if (!blob) throw new Error("截圖失敗");

	if (
		typeof (window as any).ClipboardItem !== "undefined" &&
		navigator.clipboard?.write
	) {
		await navigator.clipboard.write([
			new ClipboardItem({ "image/png": blob }),
		]);
		return "clipboard";
	}

	const url = URL.createObjectURL(blob);
	try {
		const a = document.createElement("a");
		a.href = url;
		a.download = filename;
		a.click();
	} finally {
		URL.revokeObjectURL(url);
	}
	return "download";
}

// Put a PNG Blob on the clipboard when the browser supports image clipboard
// writes, otherwise fall back to triggering a download. Exceptions propagate to
// the caller, which toasts.
//
// The Blob is produced by EmbedPDF's pdfium render capability (page rendered
// WITH annotations) rather than DOM-rasterising the wasm-rendered page — the
// latter (html-to-image) chokes on the page's blob: bitmap + cross-origin CSS.

export async function blobToClipboard(
	blob: Blob,
	filename = "slide.png",
): Promise<"clipboard" | "download"> {
	if (
		typeof (window as any).ClipboardItem !== "undefined" &&
		navigator.clipboard?.write
	) {
		try {
			await navigator.clipboard.write([
				new ClipboardItem({ "image/png": blob }),
			]);
			return "clipboard";
		} catch {
			// Some browsers reject image clipboard writes (permissions / headless);
			// fall through to a download so the user still gets the image.
		}
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

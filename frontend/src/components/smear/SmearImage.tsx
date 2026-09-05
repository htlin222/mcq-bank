import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, Copy, X } from "lucide-react";
import { copyImageToClipboard, supportsClipboardImageWrite } from "../../lib/copyImage";

/**
 * 抹片影像:預設顯示 `view` 尺寸(長邊 1600),點擊放大成全螢幕檢視
 * `full` 尺寸(長邊 2400)並允許原生 pinch-zoom。
 *
 * ⚠️ 刻意不對圖片或其容器設 `touch-action: none` —— 那會直接擋掉原生
 * pinch-zoom,而「準備兩種尺寸的圖」整個功能存在的理由就是讓瀏覽器自己的
 * 縮放接手。也刻意不引入縮放函式庫:這裡要的只是「顯示一張靜態圖、讓
 * OS 自己處理縮放」,repo 裡已有的 `@embedpdf/plugin-zoom` 是給多頁 PDF
 * 導覽用的,拿來做這個完全不成比例。
 */
export function SmearImage({
	viewKey,
	fullKey,
	alt,
}: {
	viewKey: string;
	fullKey: string;
	alt?: string;
}) {
	const [zoomed, setZoomed] = useState(false);

	return (
		<>
			<div className="relative bg-ink-900 dark:bg-black rounded-lg overflow-hidden">
				<button
					type="button"
					onClick={() => setZoomed(true)}
					className="block w-full"
					aria-label="放大檢視抹片影像"
				>
					{/* eslint-disable-next-line jsx-a11y/img-redundant-alt */}
					<img
						src={`/img/${viewKey}`}
						alt={alt ?? "抹片影像"}
						className="w-full h-auto max-h-[65dvh] object-contain mx-auto"
					/>
				</button>
				<span className="absolute bottom-2 right-2 text-xs text-white bg-black/60 px-2 py-0.5 rounded pointer-events-none">
					點擊放大
				</span>
				{/* 獨立於放大鈕之外的 sibling,不是巢狀在它裡面 —— 點下去不會觸發放大,
				    不需要 stopPropagation。放在左上角,跟右下角的「點擊放大」提示錯開。 */}
				<CopyImageButton url={`/img/${viewKey}`} className="absolute top-2 left-2" />
			</div>
			{zoomed &&
				createPortal(
					<FullScreenImage
						src={`/img/${fullKey}`}
						alt={alt ?? "抹片影像(放大)"}
						onClose={() => setZoomed(false)}
					/>,
					document.body,
				)}
		</>
	);
}

/**
 * 複製圖片到剪貼簿的按鈕 —— 縮圖卡與全螢幕檢視共用同一顆(見檔頭 SmearImage
 * 的說明:兩個呼叫端都要有這個功能,寫一份就好)。
 *
 * 三種狀態:idle(Copy 圖示)→ done(打勾,1.5 秒後revert,同
 * QuestionCard.tsx「複製為 Markdown」的節奏)/ error(顯示一句提示,3 秒後
 * revert)。**不支援時直接在同一個手勢裡開新分頁**,不要等非同步的
 * write() 失敗才嘗試開分頁 —— 那個 window.open 已經脫離使用者手勢的呼叫堆疊,
 * 大多數瀏覽器的彈出視窗攔截會擋下來。
 */
function CopyImageButton({
	url,
	className = "",
}: {
	url: string;
	className?: string;
}) {
	const [state, setState] = useState<"idle" | "done" | "error">("idle");
	const timer = useRef<number | null>(null);

	useEffect(() => {
		return () => {
			if (timer.current !== null) window.clearTimeout(timer.current);
		};
	}, []);

	function resetAfter(ms: number, s: "idle") {
		if (timer.current !== null) window.clearTimeout(timer.current);
		timer.current = window.setTimeout(() => setState(s), ms);
	}

	function handleClick(e: React.MouseEvent) {
		e.preventDefault();
		e.stopPropagation();
		if (!supportsClipboardImageWrite()) {
			// 仍在使用者手勢的呼叫堆疊裡,同步開新分頁 —— 讓使用者自己長按/右鍵
			// 另存,不會被彈出視窗攔截擋下來。
			window.open(url, "_blank", "noopener");
			return;
		}
		// copyImageToClipboard 內部不 await 就呼叫 clipboard.write(),這裡的
		// .then 只是接結果、不影響它是不是同步呼叫的。
		copyImageToClipboard(url).then(
			() => {
				setState("done");
				resetAfter(1500, "idle");
			},
			() => {
				setState("error");
				resetAfter(3000, "idle");
			},
		);
	}

	return (
		<div className={`relative ${className}`}>
			<button
				type="button"
				onClick={handleClick}
				aria-label={state === "done" ? "圖片已複製" : "複製圖片"}
				title={state === "done" ? "已複製" : "複製圖片"}
				data-testid="copy-image-button"
				className={
					"flex items-center justify-center w-10 h-10 rounded-full transition " +
					(state === "done"
						? "bg-emerald-600 text-white"
						: "bg-black/60 text-white hover:bg-black/80")
				}
			>
				{state === "done" ? <Check size={17} /> : <Copy size={16} />}
			</button>
			{state === "error" && (
				<p className="absolute left-0 top-full mt-1 w-48 text-[11px] leading-snug text-white bg-black/80 rounded px-2 py-1.5 z-10 break-words">
					此瀏覽器不支援複製圖片,請長按或右鍵圖片另存。
				</p>
			)}
		</div>
	);
}

function FullScreenImage({
	src,
	alt,
	onClose,
}: {
	src: string;
	alt: string;
	onClose: () => void;
}) {
	useEffect(() => {
		function onKey(e: KeyboardEvent) {
			if (e.key === "Escape") onClose();
		}
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [onClose]);

	return (
		// `.dialog-scrim` 讓關閉鈕落在安全區內(見 CLAUDE.md「對話框的安全區」)。
		// 關閉鈕走一般文件流(不是絕對定位)—— 絕對定位的偏移是量到容器的
		// **padding box 外緣**,會直接蓋過 `.dialog-scrim` 讓出來的安全區留白。
		<div className="fixed inset-0 z-50 bg-black/95 dialog-scrim flex flex-col">
			<div className="flex justify-between items-center shrink-0 mb-2">
				<CopyImageButton url={src} />
				<button
					type="button"
					onClick={onClose}
					aria-label="關閉放大檢視"
					className="p-2 rounded-full bg-white/10 text-white hover:bg-white/20"
				>
					<X size={22} />
				</button>
			</div>
			{/* 點擊圖片以外的區域關閉;圖片本身與這層容器都不設 touch-action,
			    原生 pinch-zoom 因此不受影響。 */}
			<div
				className="flex-1 min-h-0 flex items-center justify-center"
				onClick={(e) => {
					if (e.target === e.currentTarget) onClose();
				}}
			>
				<img src={src} alt={alt} className="max-w-full max-h-full object-contain" />
			</div>
		</div>
	);
}

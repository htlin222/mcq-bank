import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

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
			<div className="flex justify-end shrink-0 mb-2">
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

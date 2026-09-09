import { useEffect } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import type { SmearGalleryItem } from "../../lib/smearApi";
import { SMEAR_TOPIC_LABELS, SMEAR_QTYPE_LABELS } from "../../lib/smearApi";
import { SmearDxPanel } from "../smear/SmearDxPanel";

/**
 * 輪播卡上點文字打開的細節對話框 —— 詳解 / 個人筆記 / 討論 / 相似,**不跳頁**。
 *
 * **內容整個交給既有的 `SmearDxPanel`,不重寫一份。** 那個面板只吃一個 `dxId`
 * 字串、自己抓自己的資料(它的檔頭寫著這正是它這樣設計的理由),所以這裡除了
 * 一層 scrim 之外什麼都不必做。自己畫一份「輪播卡專用的詳解檢視」的代價不是
 * 行數,是漂移:那四個分頁之後每加一個功能都會有一邊漏掉,而症狀是「從首頁點
 * 進去少一塊」,沒有人會回報得清楚(同 CLAUDE.md「檢討介面只有一套」)。
 *
 * **「看完整診斷」那個連結留著,沒有被這個對話框取代。** 兩者回答不同的問題:
 * 對話框是「這張圖在講什麼」(看完就關掉,回到輪播),連結是「我要停在這個診斷
 * 上」—— 後者有網址可以貼給別人,而且那一頁還帶著這個診斷的**所有**圖片,
 * 面板裡沒有。
 */
export function SmearGalleryDetailDialog({
	item,
	onClose,
}: {
	item: SmearGalleryItem;
	onClose: () => void;
}) {
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [onClose]);

	const title = item.canonical_abbrev
		? `${item.canonical_long}(${item.canonical_abbrev})`
		: item.canonical_long;

	return createPortal(
		// dialog-scrim 讓四周縮進安全區(見 styles.css 與 lib/mobileChrome.test.ts)。
		// ⚠️ 面板配 `max-h-full` 而不是 `max-h-[calc(100dvh-2rem)]` —— 那個 2rem 是
		// scrim 的 p-4 的鏡像,而 scrim 的 padding 現在會長出一個 inset,面板就比
		// padding box 還高而溢出去,安全區白讓。
		<div
			className="fixed inset-0 z-50 bg-black/50 dialog-scrim flex items-center justify-center"
			role="dialog"
			aria-modal="true"
			aria-label={`${item.canonical_long} 的詳解`}
			data-smear-detail-dialog
			onClick={onClose}
		>
			<div
				className="bg-white dark:bg-ink-800 rounded-lg shadow-xl w-full max-w-3xl max-h-full flex flex-col overflow-hidden"
				// scrim 收到的點擊才是「點到外面」。不擋的話,在面板裡選字、拖曳
				// 捲軸放開的那一下都會把對話框關掉。
				onClick={(e) => e.stopPropagation()}
			>
				<div className="flex items-start gap-3 px-5 py-3 border-b border-ink-100 dark:border-ink-700 shrink-0">
					<div className="min-w-0">
						<h2 className="font-serif text-lg text-ink-900 dark:text-ink-100 break-words">
							{title}
						</h2>
						<div className="mt-1 flex flex-wrap gap-1.5">
							<Badge>{SMEAR_TOPIC_LABELS[item.topic] ?? item.topic}</Badge>
							<Badge>{SMEAR_QTYPE_LABELS[item.qtype] ?? item.qtype}</Badge>
						</div>
					</div>
					<button
						type="button"
						onClick={onClose}
						aria-label="關閉"
						className="ml-auto shrink-0 p-1.5 rounded text-ink-500 dark:text-ink-400 hover:text-accent hover:bg-ink-50 dark:hover:bg-ink-700 transition"
					>
						<X size={18} strokeWidth={1.75} />
					</button>
				</div>

				{/* 捲軸給這一層,不是給 SmearDxPanel —— 那個面板在別處是嵌在頁面裡的,
				    它自己不假設有一個固定高度的容器。 */}
				<div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
					<SmearDxPanel dxId={item.dx_id} />
				</div>
			</div>
		</div>,
		document.body,
	);
}

function Badge({ children }: { children: React.ReactNode }) {
	return (
		<span className="text-xs px-2 py-0.5 rounded-full border border-ink-200 dark:border-ink-600 text-ink-500 dark:text-ink-400">
			{children}
		</span>
	);
}

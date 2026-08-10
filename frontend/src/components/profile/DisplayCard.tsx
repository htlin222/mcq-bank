import { useState } from "react";
import { Smartphone } from "lucide-react";
import {
	applyViewportMode,
	readViewportMode,
	viewportModeSupported,
	writeViewportMode,
	type ViewportMode,
} from "../../lib/viewportMode";

/**
 * 顯示偏好 —— 目前只有「強制手機版面」(#135)。
 *
 * 這個設定原本是左下角一顆 FAB。搬進來的理由:它是**設定一次就不會再碰**的東西
 * (平板/電子紙上決定用哪種版面),卻佔著每一頁的左下角,還會壓住內容 ——
 * 每天都在按的番茄鐘和回到頂端才值得那個位置。
 *
 * ⚠️ 桌機瀏覽器完全忽略 viewport meta,所以在不支援的裝置上整張卡不出現
 * (`viewportModeSupported()` 問的是 `(pointer: coarse)`)—— 一個按了沒反應的
 * 開關比沒有更糟。機制的細節在 lib/viewportMode.ts。
 */
export function DisplayCard() {
	// 一次算完就好:`(pointer: coarse)` 在一次工作階段裡不會變(不像視窗寬度)。
	const [supported] = useState(viewportModeSupported);
	const [mode, setMode] = useState<ViewportMode>(readViewportMode);

	if (!supported) return null;

	const on = mode === "mobile";
	const next: ViewportMode = on ? "auto" : "mobile";

	return (
		<div
			id="profile-display"
			className="scroll-mt-[calc(var(--header-h)+1.5rem)] bg-white dark:bg-ink-800 border border-ink-200 dark:border-ink-700 rounded-lg p-6 sm:p-8 shadow-paper mt-6"
		>
			<h2 className="font-serif text-xl text-ink-900 dark:text-ink-100 mb-1">
				顯示
			</h2>
			<p className="text-sm text-ink-500 dark:text-ink-400 mb-6">
				這些設定只影響這台裝置,不會同步到你的其他裝置。
			</p>

			<div className="flex items-start justify-between gap-6">
				<div className="min-w-0">
					<div className="flex items-center gap-2 text-ink-800 dark:text-ink-100">
						<Smartphone size={16} className="shrink-0 text-ink-400" />
						<span className="font-medium">強制手機版面</span>
					</div>
					<p className="mt-1 text-sm text-ink-500 dark:text-ink-400">
						在平板或電子紙上把兩欄收成單欄分頁,跟手機一樣。關掉則依螢幕寬度自動排版。
					</p>
				</div>
				<button
					type="button"
					role="switch"
					aria-checked={on}
					aria-label="強制手機版面"
					onClick={() => {
						const before = window.innerWidth;
						writeViewportMode(next);
						applyViewportMode(next);
						setMode(next);
						// 改寫 meta 之後引擎「應該」立刻重算視窗寬度(Blink 與 WebKit 都會),
						// 但這件事驗不到 —— Playwright 兩個引擎都用 setDeviceMetricsOverride
						// 把版面視窗釘死。所以自己量:寬度沒動就代表這個引擎不吃動態修改,
						// 重新載入一次(從 HTML 解析進來的 meta 是所有引擎都認的)。
						//
						// 常見情況(Android/BOOX)寬度會馬上改變,不會重整。這裡是個人頁,
						// 沒有編輯中的草稿會被重整弄丟。
						window.setTimeout(() => {
							if (window.innerWidth === before) window.location.reload();
						}, 300);
					}}
					className={
						"relative h-6 w-11 shrink-0 rounded-full transition " +
						(on ? "bg-accent" : "bg-ink-300 dark:bg-ink-600")
					}
				>
					<span
						className={
							"absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all " +
							(on ? "left-[1.375rem]" : "left-0.5")
						}
					/>
				</button>
			</div>
		</div>
	);
}

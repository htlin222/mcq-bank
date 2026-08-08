import { useState } from "react";
import { Smartphone } from "lucide-react";
import {
	applyViewportMode,
	readViewportMode,
	viewportModeSupported,
	writeViewportMode,
	type ViewportMode,
} from "../lib/viewportMode";

/**
 * 「強制手機版面」——(#94)平板/電子紙上把整個 app 切成手機版,再按一次切回。
 * 機制與「為什麼桌機看不到這顆按鈕」都寫在 lib/viewportMode.ts。
 *
 * 位置疊在番茄鐘上面(同一個右下角、同一條 --bottom-nav-h 基準),不另開一區。
 */
export function ViewportModeFab() {
	// 一次算完就好:`(pointer: coarse)` 在一次工作階段裡不會變(不像視窗寬度),
	// 而且 render 期間直接讀 matchMedia 會讓每次重繪都問一次瀏覽器。
	const [supported] = useState(viewportModeSupported);
	const [mode, setMode] = useState<ViewportMode>(readViewportMode);

	if (!supported) return null;

	const next: ViewportMode = mode === "mobile" ? "auto" : "mobile";

	return (
		<button
			type="button"
			onClick={() => {
				const before = window.innerWidth;
				writeViewportMode(next);
				applyViewportMode(next);
				setMode(next);
				// 改寫 meta 之後,引擎「應該」立刻重算視窗寬度(Blink 與 WebKit 都會)。
				// 但這件事我們驗不到 —— Playwright 兩個引擎都用 setDeviceMetricsOverride
				// 把版面視窗釘死,meta 寫對了也不會反映在 innerWidth 上,所以測試只能鎖
				// 「寫進去的內容對不對」。因此這裡自己量:寬度沒動就代表這個引擎不吃動態
				// 修改,重新載入一次 —— 從 HTML 解析那條路徑進來的 meta 是所有引擎都認的。
				//
				// 常見情況(Android/BOOX)寬度會馬上改變,不會重整,所以編輯中的草稿不受
				// 影響。重整只發生在點擊當下、且只有一次,不會變成迴圈。
				window.setTimeout(() => {
					if (window.innerWidth === before) window.location.reload();
				}, 300);
			}}
			aria-pressed={mode === "mobile"}
			title={
				mode === "mobile"
					? "目前是強制手機版面,點一下回到依螢幕寬度自動排版"
					: "強制用手機版面(在平板/電子紙上把兩欄收成單欄分頁)"
			}
			aria-label={mode === "mobile" ? "回到自動版面" : "強制手機版面"}
			className={
				"fixed left-4 z-30 bottom-[calc(var(--bottom-nav-h)+4.5rem)] " +
				"h-12 w-12 grid place-items-center rounded-full border shadow-paper transition " +
				(mode === "mobile"
					? "border-accent bg-accent text-white eink-invert"
					: "border-ink-200 dark:border-ink-700 bg-white dark:bg-ink-800 text-ink-500 dark:text-ink-400 hover:text-accent hover:border-accent")
			}
		>
			{/* 兩個狀態同一個圖示,靠實心/描邊(與 aria-pressed)區分開關。
          原本開著時換成 Monitor,但 header 的主題切換在「跟隨系統」時用的正是
          Monitor —— 同一個畫面兩顆意思完全不同的螢幕圖示,比沒有變化更難讀。 */}
			<Smartphone size={20} />
		</button>
	);
}

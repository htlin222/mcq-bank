import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight, Pause, Play, X } from "lucide-react";
import type { SmearGalleryItem } from "../../lib/smearApi";
import { GalleryCaption, GalleryImage } from "./SmearGalleryParts";

/**
 * 全螢幕螢幕保護 —— 輪播卡右上角那顆 ⛶ 開的東西。輪播的狀態(現在第幾張、
 * 有沒有暫停)全部留在卡片那邊,這裡只換一套版面。
 *
 * **版面是自己畫的 fixed overlay,`requestFullscreen()` 只是「順便」。**
 * iOS Safari 不支援對非 `<video>` 元素全螢幕 —— 只靠它的話這個功能在手機上
 * 整個不存在。overlay 在哪裡都蓋得住視窗;全螢幕 API 成功時再額外把瀏覽器的
 * 網址列一起收掉。
 *
 * 螢幕保護的兩個語彙:滑鼠不動三秒控制列淡出,以及盡量不讓螢幕睡著
 * (Wake Lock —— 會睡著的螢幕保護不是螢幕保護)。兩者都是 best-effort。
 */
const IDLE_HIDE_MS = 3000;

export function SmearScreensaver({
	item,
	paused,
	eink,
	onNext,
	onPrev,
	onTogglePause,
	onClose,
}: {
	item: SmearGalleryItem;
	paused: boolean;
	eink: boolean;
	onNext: () => void;
	onPrev: () => void;
	onTogglePause: () => void;
	onClose: () => void;
}) {
	const hostRef = useRef<HTMLDivElement | null>(null);
	const [showChrome, setShowChrome] = useState(true);

	// 進場:試著要真的全螢幕 + Wake Lock。**Wake Lock 要使用者手勢**,而點下
	// 那顆 ⛶ 就是 —— 換到別的時機(例如自動進入)會靜靜失敗。
	useEffect(() => {
		const el = hostRef.current;
		el?.requestFullscreen?.().catch(() => {
			/* iOS Safari 之類不支援 —— overlay 本身已經蓋滿視窗了 */
		});

		type WakeLockSentinel = { release(): Promise<void> };
		type WakeLockNavigator = {
			wakeLock?: { request(type: "screen"): Promise<WakeLockSentinel> };
		};
		let sentinel: WakeLockSentinel | null = null;
		let released = false;
		(navigator as unknown as WakeLockNavigator).wakeLock
			?.request("screen")
			.then((s) => {
				// 拿到的時候可能已經關掉了(await 期間 unmount)—— 不釋放的話,
				// 離開螢幕保護之後螢幕還是不會睡。
				if (released) void s.release().catch(() => {});
				else sentinel = s;
			})
			.catch(() => {
				/* 沒有就算了,只是螢幕會照系統設定睡著 */
			});

		return () => {
			released = true;
			void sentinel?.release().catch(() => {});
			if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
		};
	}, []);

	// 使用者用瀏覽器自己的方式離開全螢幕(Esc、F11、手勢)時把 overlay 一起關掉。
	// ⚠️ 不同步的話會留下一個蓋住整頁、看起來關不掉的黑畫面 —— 而使用者剛按過
	// 一次 Esc,只會覺得「按了沒反應」。
	useEffect(() => {
		const onFsChange = () => {
			if (!document.fullscreenElement) onClose();
		};
		document.addEventListener("fullscreenchange", onFsChange);
		return () => document.removeEventListener("fullscreenchange", onFsChange);
	}, [onClose]);

	// 鍵盤:← → 翻頁、空白鍵暫停、Esc 離開。**Esc 一定要自己接** —— 全螢幕 API
	// 沒有成功時(iOS、或使用者拒絕)瀏覽器不會替我們處理它,那時 Esc 是唯一
	// 沒有滑鼠的離開方式。
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "ArrowRight") onNext();
			else if (e.key === "ArrowLeft") onPrev();
			else if (e.key === "Escape") onClose();
			else if (e.key === " " || e.key === "Spacebar") {
				e.preventDefault();
				onTogglePause();
			} else return;
			setShowChrome(true);
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [onNext, onPrev, onClose, onTogglePause]);

	// 滑鼠不動就把控制列淡出。⚠️ e-ink 下完全不做:每次淡入淡出都是一次全屏
	// 刷新,而殘影會讓控制列「半留在畫面上」,比一直顯示更糟。
	useEffect(() => {
		if (eink) return;
		let t = window.setTimeout(() => setShowChrome(false), IDLE_HIDE_MS);
		const bump = () => {
			setShowChrome(true);
			window.clearTimeout(t);
			t = window.setTimeout(() => setShowChrome(false), IDLE_HIDE_MS);
		};
		document.addEventListener("mousemove", bump);
		document.addEventListener("touchstart", bump);
		return () => {
			window.clearTimeout(t);
			document.removeEventListener("mousemove", bump);
			document.removeEventListener("touchstart", bump);
		};
	}, [eink]);

	return createPortal(
		<div
			ref={hostRef}
			data-smear-screensaver
			className="fixed inset-0 z-50 bg-black"
			role="dialog"
			aria-modal="true"
			aria-label="抹片全螢幕輪播"
		>
			{/* 底色鋪在外層、內容縮在安全區裡(見 styles.css 的 .screensaver-safe)。
			    ⚠️ 這裡的離開鈕在 iOS 上是唯一的出路 —— `requestFullscreen()` 會被
			    拒絕,所以瀏覽器不會替我們處理 Esc,而手機也沒有鍵盤。它落在瀏海
			    底下就等於出不去。 */}
			<div className="absolute inset-0 screensaver-safe flex flex-col lg:flex-row">
				{/* 全螢幕用 full 尺寸(長邊 2400)—— 這裡的畫面可能是一台投影機。 */}
				<GalleryImage
					item={item}
					sizeKey="image_key_full"
					className="flex-1 min-h-0 bg-black"
				/>

				{/* 說明:寬螢幕是右側欄,窄螢幕是底部長條。**兩者都是實心底,不是
				    半透明疊在圖上** —— 疊上去會蓋掉圖的一角,而那一角可能正是
				    image_note 的箭頭指的地方。

				    ⚠️ **控制列在這一欄裡,不是絕對定位浮在角落。** 浮在右上角時它
				    正好壓在說明的標題上(離開鈕蓋住診斷名的最後幾個字),而那是
				    唯一一行不能被蓋到的東西。放進版面流裡就不會有這種事,窄螢幕
				    時它也順勢落到底部 —— 拇指按得到的地方。

				    淡出時只改 opacity 不改 display:抽掉的話說明會整段上跳,而
				    「滑鼠不動三秒版面自己動一下」比留一排看不見的按鈕糟。 */}
				<div className="lg:w-80 xl:w-96 shrink-0 bg-ink-900 border-t lg:border-t-0 lg:border-l border-ink-700 p-5 overflow-y-auto flex flex-col gap-4">
					<div
						className={`flex items-center justify-end gap-2 shrink-0 transition-opacity ${
							showChrome ? "opacity-100" : "opacity-0 pointer-events-none"
						}`}
					>
						<ScreenButton label="上一張" onClick={onPrev}>
							<ChevronLeft size={20} strokeWidth={1.75} />
						</ScreenButton>
						<ScreenButton label="下一張" onClick={onNext}>
							<ChevronRight size={20} strokeWidth={1.75} />
						</ScreenButton>
						{/* e-ink 下自動輪播是強制關的,所以不畫這顆 —— 同輪播卡,按了
						    沒反應的鍵比少一顆鍵糟。 */}
						{!eink && (
							<ScreenButton
								label={paused ? "開始自動輪播" : "暫停自動輪播"}
								onClick={onTogglePause}
							>
								{paused ? (
									<Play size={20} strokeWidth={1.75} />
								) : (
									<Pause size={20} strokeWidth={1.75} />
								)}
							</ScreenButton>
						)}
						<ScreenButton label="離開全螢幕" onClick={onClose}>
							<X size={20} strokeWidth={1.75} />
						</ScreenButton>
					</div>
					{/* 全螢幕不截斷 —— 這一欄整片空著,收成三行是把版面的限制當成
					    內容的限制。 */}
					<GalleryCaption item={item} dark clamp={false} />
				</div>
			</div>
		</div>,
		document.body,
	);
}

function ScreenButton({
	label,
	onClick,
	children,
}: {
	label: string;
	onClick: () => void;
	children: React.ReactNode;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			aria-label={label}
			title={label}
			className="p-2 rounded-full bg-ink-800 text-ink-200 border border-ink-600 hover:text-white hover:bg-ink-700 transition"
		>
			{children}
		</button>
	);
}

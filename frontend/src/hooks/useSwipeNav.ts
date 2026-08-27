import { useRef } from "react";
import {
	scrollerBlocks,
	swipeDirection,
	type ScrollerState,
	type SwipePoint,
} from "../lib/swipeNav";

/**
 * 從手指落點往上找,在抵達 `stop` 之前有沒有一個左右可捲的容器。
 *
 * 用 `getComputedStyle` 問 `overflow-x` 而不是認 class 名 —— 會左右捲的東西
 * 至少有兩種(`.table-scroll` 與 `.tiptap pre`),而列舉 class 的清單會腐爛:
 * 下次有人加第三種,症狀是「在那個東西上橫拖會換筆記」,不會有人聯想到這裡。
 */
function scrollableAncestor(
	from: EventTarget | null,
	stop: Element,
): ScrollerState | null {
	let el = from instanceof Element ? from : null;
	while (el && el !== stop) {
		if (el instanceof HTMLElement && el.scrollWidth > el.clientWidth + 1) {
			const ox = getComputedStyle(el).overflowX;
			if (ox === "auto" || ox === "scroll") {
				return {
					scrollLeft: el.scrollLeft,
					scrollWidth: el.scrollWidth,
					clientWidth: el.clientWidth,
				};
			}
		}
		el = el.parentElement;
	}
	return null;
}

/**
 * 「在這一塊上左右滑,換上一個 / 下一個」的接線。方向判準是純函式
 * (`lib/swipeNav.ts`),這裡只負責三件 DOM 才知道的事:多指、手指底下有沒有
 * 東西還捲得動、以及選取範圍在不在這一塊裡。
 *
 * **用 Touch events 而不是 Pointer events。** 瀏覽器一旦認定手勢是捲動就會送出
 * `pointercancel`,而在一個只能垂直捲的頁面上,水平拖曳常常在我們看清方向之前
 * 就被收走 —— 那會讓滑動時靈時不靈。touch 那組不會:實測 WebKit 與 Blink 在
 * 頁面真的捲了 633px 之後,仍然照常送出 `touchend` 且座標正確,一次 `touchcancel`
 * 都沒有(React 18 的 touch listener 是 passive,瀏覽器不必把手勢收走)。
 * 也因此 `touchcancel` 在這裡只當成「系統把手勢拿走了」處理,不拿來判方向。
 *
 * 只有觸控裝置會發這些事件,所以不必另外問 `(pointer: coarse)` —— 滑鼠一律
 * 走不到這裡,桌機使用者橫向拖曳選字不會誤觸。
 */
export function useSwipeNav({
	enabled,
	onLeft,
	onRight,
}: {
	enabled: boolean;
	onLeft: () => void;
	onRight: () => void;
}) {
	const start = useRef<SwipePoint | null>(null);
	// 起手當下量到的可捲容器狀態。**一定要在 touchstart 量**:捲動位置在手勢過程
	// 中會變,從表格中段拖到最右緣的話,touchend 時它已經到底,那時再問就放行了。
	const scroller = useRef<ScrollerState | null>(null);

	return {
		onTouchStart(e: React.TouchEvent) {
			// 兩指以上是縮放 / 雙指捲動,不是換頁。
			if (!enabled || e.touches.length !== 1) {
				start.current = null;
				return;
			}
			const t = e.touches[0];
			start.current = { x: t.clientX, y: t.clientY, t: e.timeStamp };
			scroller.current = scrollableAncestor(e.target, e.currentTarget);
		},
		onTouchMove(e: React.TouchEvent) {
			// 中途多一根手指就整個放棄:縮放的第二指落下時,第一指的位移已經沒有
			// 「換頁」的意思了。
			if (e.touches.length > 1) start.current = null;
		},
		onTouchEnd(e: React.TouchEvent) {
			const from = start.current;
			const scr = scroller.current;
			start.current = null;
			scroller.current = null;
			if (!from) return;

			// 手上有選取就不換頁。內文是可以畫螢光的(AnnotatableContent),而選字
			// 被換頁打斷,使用者要重選一次還不知道剛才發生什麼事 —— `SWIPE_MAX_MS`
			// 已經擋掉大部分,這是第二層。
			// **範圍收在這一塊裡面**:`KeepAlive` 會把切走的分頁留著只是藏起來
			// (見 CLAUDE.md 的分頁快取那節),所以留在詳解裡的選取會讓筆記這邊
			// 滑不動 —— 而使用者看不到那段選取,也沒地方去清掉它。
			const sel =
				typeof window !== "undefined" ? window.getSelection() : null;
			if (
				sel &&
				!sel.isCollapsed &&
				sel.anchorNode &&
				e.currentTarget.contains(sel.anchorNode)
			)
				return;

			const t = e.changedTouches[0];
			if (!t) return;
			const dir = swipeDirection(
				from,
				{ x: t.clientX, y: t.clientY, t: e.timeStamp },
				window.innerWidth,
			);
			if (!dir) return;
			// 手指底下那張表 / 那段程式碼還捲得動 —— 這一下是捲它,不是換頁。
			if (scr && scrollerBlocks(scr, dir)) return;
			if (dir === "left") onLeft();
			else onRight();
		},
		// 系統把手勢收走(來電、下拉通知)時清乾淨,否則下一次 touchend 會拿
		// 上一次的起點去算,量出一個莫名其妙的位移。
		onTouchCancel() {
			start.current = null;
			scroller.current = null;
		},
	};
}

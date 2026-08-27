import { useRef } from "react";
import { swipeDirection, type SwipePoint } from "../lib/swipeNav";

/**
 * 「在這一塊上左右滑,換上一個 / 下一個」的接線。方向判準是純函式
 * (`lib/swipeNav.ts`),這裡只負責三件 DOM 才知道的事:多指、選字、以及把
 * 起訖點收好。
 *
 * **用 Touch events 而不是 Pointer events。** 瀏覽器一旦認定手勢是捲動就會送出
 * `pointercancel`,而在一個只能垂直捲的頁面上,水平拖曳常常在我們看清方向之前
 * 就被判成捲動 —— 那會讓滑動時靈時不靈。touch 那組不會被這樣收走。
 * (同 `routes/Play.tsx`;差別是那裡的棋盤不捲,可以直接 `touch-action: none`。)
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

	return {
		onTouchStart(e: React.TouchEvent) {
			// 兩指以上是縮放 / 雙指捲動,不是換頁。
			if (!enabled || e.touches.length !== 1) {
				start.current = null;
				return;
			}
			const t = e.touches[0];
			start.current = { x: t.clientX, y: t.clientY, t: e.timeStamp };
		},
		onTouchMove(e: React.TouchEvent) {
			// 中途多一根手指就整個放棄:縮放的第二指落下時,第一指的位移已經沒有
			// 「換頁」的意思了。
			if (e.touches.length > 1) start.current = null;
		},
		onTouchEnd(e: React.TouchEvent) {
			const from = start.current;
			start.current = null;
			if (!from) return;

			// 手上有選取就不換頁。筆記內文是可以畫螢光的(AnnotatableContent),
			// 而選字被換頁打斷,使用者要重選一次還不知道剛才發生什麼事 ——
			// `SWIPE_MAX_MS` 已經擋掉大部分,這是第二層。
			// 副作用是「選字工具列開著時滑不動」,那是要的:那時的意圖在那段文字上。
			const sel =
				typeof window !== "undefined" ? window.getSelection() : null;
			if (sel && !sel.isCollapsed) return;

			const t = e.changedTouches[0];
			if (!t) return;
			const dir = swipeDirection(
				from,
				{ x: t.clientX, y: t.clientY, t: e.timeStamp },
				window.innerWidth,
			);
			if (dir === "left") onLeft();
			else if (dir === "right") onRight();
		},
		// 系統把手勢收走(來電、下拉通知)時清乾淨,否則下一次 touchend 會拿
		// 上一次的起點去算,量出一個莫名其妙的位移。
		onTouchCancel() {
			start.current = null;
		},
	};
}

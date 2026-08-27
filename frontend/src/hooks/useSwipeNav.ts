import {
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import {
	lockDecision,
	startsInEdge,
	type ScrollerState,
} from "../lib/swipeNav";
import { dampedOffset, flyOutOffset, shouldCommit } from "../lib/swipeDrag";

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
 * 卡片跟著手指走、過臨界點就換過去(#196 的第二版)。
 *
 * **必須用原生的非被動監聽器,不能用 React 的 `onTouchMove`。** React 18 把
 * touchstart/touchmove 一律註冊成 passive,`preventDefault()` 在那裡是無效的
 * —— 結果會是卡片跟著手指走的同時,頁面也在捲,兩件事疊在一起。
 *
 * **也不能改用 `touch-action: pan-y` 把橫向交給我們。** 那個屬性是沿著祖先鏈
 * **取交集**的:卡片上寫了 `pan-y`,底下 `.table-scroll` 的表格就再也橫捲不動,
 * 而且子元素**無法**把它加回來。那會直接推翻上一版才修好的「在可左右捲的東西上
 * 橫拖是捲它」。
 *
 * 判準:
 *   - 鎖定(接管手勢)要同時滿足:單指、不在螢幕邊緣起手、手指底下沒有還捲得動
 *     的東西、角度在 34° 內、位移超過 LOCK_PX、而且**當下沒有非收合的選取**。
 *   - 鎖定之後每一幀 `preventDefault()` + 位移卡片,放手依 `shouldCommit` 決定。
 *
 * ⚠️ **舊版的 700ms 上限已經拿掉。** 它原本用來擋選字,但直接操作之下「慢慢拖過
 * 臨界點」是正常操作,用時間擋會讓一個正確的手勢無聲彈回去。選字改成在鎖定的那
 * 一刻檢查 selection —— 真的在選字時,那時一定有一段非收合的選取。
 */
export function useSwipeNav({
	cardRef,
	enabled,
	onLeft,
	onRight,
}: {
	/** 寫得進去的 ref —— `RefObject` 在新版型別裡 `current` 是唯讀的。 */
	cardRef: { current: HTMLElement | null };
	enabled: boolean;
	onLeft: () => void;
	onRight: () => void;
}) {
	// 回呼每次 render 都是新的,但監聽器只掛一次 —— 放進 ref 才不會抓到舊的閉包。
	const cb = useRef({ enabled, onLeft, onRight });
	cb.current = { enabled, onLeft, onRight };

	// ⚠️ **不能只靠傳進來的 RefObject。** 筆記卡在 `KeepAlive` 底下,要切到那個
	// 分頁才會掛上,而 ref 物件的 identity 從頭到尾不變 —— effect 只在元件掛載時
	// 跑那一次,那時 `cardRef.current` 還是 null,於是**監聽器從來沒有被掛上去**。
	// 症狀是「滑動完全沒反應」,而所有純函式測試照樣全綠。
	// 改成 callback ref:元素真的出現/消失時 React 才會呼叫它,effect 就跟著跑。
	const [node, setNode] = useState<HTMLElement | null>(null);
	const attachRef = useCallback(
		(el: HTMLElement | null) => {
			cardRef.current = el;
			setNode(el);
		},
		[cardRef],
	);

	useEffect(() => {
		const card = node;
		if (!card) return;

		let startX = 0;
		let startY = 0;
		let startT = 0;
		let locked = false;
		/** null = 這一次手勢已經放棄,不再看它的 move。 */
		let live = false;
		let scroller: ScrollerState | null = null;
		let raf = 0;
		let pending = 0;

		const paint = (px: number) => {
			pending = px;
			if (raf) return;
			raf = requestAnimationFrame(() => {
				raf = 0;
				card.style.transform = pending ? `translateX(${pending}px)` : "";
			});
		};

		const settle = (transitionMs: number, to: number) => {
			if (raf) {
				cancelAnimationFrame(raf);
				raf = 0;
			}
			card.style.transition = transitionMs
				? `transform ${transitionMs}ms cubic-bezier(.22,.61,.36,1)`
				: "";
			card.style.transform = to ? `translateX(${to}px)` : "";
		};

		const reset = () => {
			locked = false;
			live = false;
			scroller = null;
			card.style.transition = "";
			card.style.transform = "";
			card.style.willChange = "";
		};

		const onStart = (e: TouchEvent) => {
			if (!cb.current.enabled || e.touches.length !== 1) {
				live = false;
				return;
			}
			const t = e.touches[0];
			// 起手就在邊緣 —— 整個手勢讓給瀏覽器的返回手勢。
			if (startsInEdge(t.clientX, window.innerWidth)) {
				live = false;
				return;
			}
			startX = t.clientX;
			startY = t.clientY;
			startT = e.timeStamp;
			locked = false;
			live = true;
			scroller = scrollableAncestor(e.target, card);
			card.style.transition = "";
		};

		const onMove = (e: TouchEvent) => {
			if (!live) return;
			if (e.touches.length > 1) {
				// 縮放的第二指落下 —— 第一指的位移已經沒有「換頁」的意思了。
				if (locked) settle(160, 0);
				reset();
				return;
			}
			const t = e.touches[0];
			const dx = t.clientX - startX;
			const dy = t.clientY - startY;

			if (!locked) {
				const verdict = lockDecision({ dx, dy, scroller });
				if (verdict === "wait") return;
				// **整段放棄,不是這一幀放棄** —— 手指在捲動途中偶然走出一段水平,
				// 不該突然變成換頁。
				if (verdict === "abandon") {
					live = false;
					return;
				}
				// 手上有選取就不接管。內文是可以畫螢光的,而選字被換頁打斷,使用者
				// 要重選一次還不知道剛才發生什麼事。範圍收在這張卡裡面 ——
				// KeepAlive 會把切走的分頁留著只是藏起來,別的分頁裡的選取不算。
				const sel = window.getSelection();
				if (
					sel &&
					!sel.isCollapsed &&
					sel.anchorNode &&
					card.contains(sel.anchorNode)
				) {
					live = false;
					return;
				}
				locked = true;
				card.style.willChange = "transform";
			}

			// 鎖定之後:接管手勢。`preventDefault` 在這裡才有效 —— 監聽器是用
			// `{ passive: false }` 掛的。
			if (e.cancelable) e.preventDefault();
			paint(dampedOffset(dx, window.innerWidth));
		};

		const onEnd = (e: TouchEvent) => {
			if (!live) {
				reset();
				return;
			}
			if (!locked) {
				reset();
				return;
			}
			const t = e.changedTouches[0];
			const dx = t ? t.clientX - startX : 0;
			const width = window.innerWidth;
			const go = shouldCommit({ dx, dtMs: e.timeStamp - startT, width });

			if (!go) {
				// 沒到臨界點:彈回去。
				settle(190, 0);
				window.setTimeout(reset, 200);
				return;
			}

			const reduce = window.matchMedia?.(
				"(prefers-reduced-motion: reduce)",
			).matches;
			const commit = () => {
				reset();
				if (dx < 0) cb.current.onLeft();
				else cb.current.onRight();
			};
			if (reduce) {
				commit();
				return;
			}
			// 飛出去,然後換內容。**新的那則不從另一邊飛進來** —— 換筆記已經有
			// goNote() 的淡入了,再加一段水平位移會變成兩種說法疊在一起。
			settle(170, flyOutOffset(dx, width));
			window.setTimeout(commit, 170);
		};

		const onCancel = () => {
			if (locked) settle(160, 0);
			reset();
		};

		// passive: false 只有 touchmove 需要(要 preventDefault);其餘保持 passive
		// 讓瀏覽器不必等我們。
		card.addEventListener("touchstart", onStart, { passive: true });
		card.addEventListener("touchmove", onMove, { passive: false });
		card.addEventListener("touchend", onEnd, { passive: true });
		card.addEventListener("touchcancel", onCancel, { passive: true });
		return () => {
			card.removeEventListener("touchstart", onStart);
			card.removeEventListener("touchmove", onMove);
			card.removeEventListener("touchend", onEnd);
			card.removeEventListener("touchcancel", onCancel);
			if (raf) cancelAnimationFrame(raf);
			card.style.transition = "";
			card.style.transform = "";
			card.style.willChange = "";
		};
		// 只依 node:enabled/onLeft/onRight 走 ref,所以元素不換就不重掛監聽器。
	}, [node]);

	return attachRef;
}

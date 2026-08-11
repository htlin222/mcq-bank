import { useEffect, type RefObject } from "react";

/**
 * 點外面或按 Esc 就關掉。三個下拉(筆記切換器、筆記工具、分頁溢出)共用。
 *
 * 抽出來的理由不是行數,是**行為要一致**:少一邊的 Esc、或某一個用 `click` 而不是
 * `mousedown`,使用者會覺得「有些選單關得掉、有些關不掉」,而那種不一致很難回報
 * 得清楚。
 *
 * 用 `mousedown` 而不是 `click`:選單裡的項目按下去會重新渲染,click 事件有機會
 * 在 DOM 換掉之後才送到,`contains()` 就會判成「點在外面」——選單先被關一次,
 * 項目的 onClick 反而收不到。
 */
export function useDismiss(
	open: boolean,
	ref: RefObject<HTMLElement | null>,
	close: () => void,
) {
	useEffect(() => {
		if (!open) return;
		function onDown(e: MouseEvent) {
			if (ref.current && !ref.current.contains(e.target as Node)) close();
		}
		function onKey(e: KeyboardEvent) {
			if (e.key === "Escape") close();
		}
		document.addEventListener("mousedown", onDown);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("mousedown", onDown);
			document.removeEventListener("keydown", onKey);
		};
		// close 由呼叫端保證穩定(通常是 setOpen(false) 的箭頭函式,每次都新的),
		// 所以不放進相依 —— 放進去會讓 listener 每次渲染都重掛。
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open, ref]);
}

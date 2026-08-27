// 「這一次觸控該不該被接管成左右滑」的判準。
//
// 純函式,所以每一道護欄的邊界都釘得住 —— 在真的瀏覽器裡用手指試探這些門檻會隨
// 引擎與當下的捲動狀態飄(同 `lib/reorder.ts` 那條)。位移與臨界值在
// `lib/swipeDrag.ts`,接線在 `hooks/useSwipeNav.ts`。
//
// ⚠️ 這裡刻意不認識「筆記」:它只回答要不要接管、以及往哪個方向。
//
// ⚠️ **舊版有一個 `swipeDirection()` 與 `SWIPE_MAX_MS`(700ms),都已經拿掉。**
// 那一版是「放手之後看整段位移」,時間上限用來擋選字。改成卡片跟著手指走之後,
// 「慢慢拖過臨界點」變成正常操作,用時間擋會讓一個正確的手勢無聲彈回去。選字改
// 由呼叫端在**鎖定的那一刻**檢查 selection —— 真的在選字時,那時一定有一段非收合
// 的選取,那是比時間更準的訊號。

/**
 * 左右螢幕邊緣的護欄。iOS Safari 從邊緣往內滑是「上一頁 / 下一頁」的返回手勢 ——
 * 搶了它,使用者會覺得返回壞掉,而那比沒有滑動換頁糟得多。
 */
export const SWIPE_EDGE = 24;

/**
 * 水平要贏過垂直多少才算「橫滑」。**這一條是承重的**:筆記卡是要捲的,不能像
 * 2048 的棋盤那樣掛 `touch-action: none` 把捲動整個關掉(見 `routes/Play.tsx`),
 * 也不能用 `pan-y`(那個屬性沿祖先鏈取交集,會讓底下的表格再也橫捲不動)。
 * 所以「這是捲動還是換頁」只能靠角度分。1.5 ≈ 34°。
 */
export const SWIPE_RATIO = 1.5;

/** 起手點在不在螢幕邊緣 —— 在的話整個手勢讓給瀏覽器。 */
export function startsInEdge(x: number, width: number): boolean {
	return x < SWIPE_EDGE || x > width - SWIPE_EDGE;
}

/**
 * 一個左右可捲容器在**起手當下**的狀態。捲動位置在手勢過程中會變,所以要在
 * touchstart 就量 —— 從表格中段拖到最右緣,放手時它已經到底了,那時再問
 * 「還捲得動嗎」會得到「不能」,於是照樣把筆記換掉。
 */
export type ScrollerState = {
	scrollLeft: number;
	scrollWidth: number;
	clientWidth: number;
};

/**
 * 手指底下那個左右可捲的東西,攔不攔得住這次滑動?
 *
 * 筆記內文裡真的有這種東西:`AnnotatableContent` 把每個 `<table>` 包進
 * `.table-scroll`(`overflow-x:auto`,而表格會被內容撐寬),`.tiptap pre` 也是。
 * 390px 上一張六欄的表必定捲得動 —— 使用者橫拖是要看右邊那幾欄,而那一下又平又
 * 快又超過門檻,角度判準一點忙都幫不上。**角度分不出這兩件事,只有問「底下有沒有
 * 東西還捲得動」分得出來。**
 *
 * 已經捲到那一側的底了就不攔:那時使用者的意圖已經不在表格上。
 */
export function scrollerBlocks(
	s: ScrollerState,
	dir: "left" | "right",
): boolean {
	const max = s.scrollWidth - s.clientWidth;
	// 1px 的容差:子像素與縮放會讓 scrollWidth 比 clientWidth 大一點點,那不是
	// 「捲得動」。少了它,幾乎每個區塊都會被當成可捲容器,整個功能靜靜失效。
	if (max <= 1) return false;
	// 往左滑 = 內容往左走 = scrollLeft 變大。
	return dir === "left" ? s.scrollLeft < max - 1 : s.scrollLeft > 1;
}

/** 手指移動這麼多之後才判斷要不要接管。 */
export const LOCK_PX = 8;

/**
 * 這一次移動之後,該接管、該放棄、還是還看不出來?
 *
 * **`abandon` 是整段放棄,不是這一幀放棄。** 呼叫端要記住它,不要每一幀再判一次
 * —— 手指在捲動途中偶然走出一段水平位移,不該突然變成換頁。
 */
export function lockDecision(o: {
	dx: number;
	dy: number;
	scroller: ScrollerState | null;
}): "wait" | "abandon" | "lock" {
	const ax = Math.abs(o.dx);
	const ay = Math.abs(o.dy);
	if (ax < LOCK_PX && ay < LOCK_PX) return "wait";
	if (ax < ay * SWIPE_RATIO) return "abandon";
	if (o.scroller && scrollerBlocks(o.scroller, o.dx < 0 ? "left" : "right"))
		return "abandon";
	return "lock";
}

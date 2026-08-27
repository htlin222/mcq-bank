// 「這一次觸控,算不算一個換頁的左右滑?」
//
// 純函式,所以四道護欄的邊界都在 `swipeNav.test.ts` 裡釘死 —— 在真的瀏覽器裡
// 用手指試探這些門檻會隨引擎與當下的捲動狀態飄(同 `lib/reorder.ts` 那條)。
//
// ⚠️ 這裡刻意不認識「筆記」:它只回答方向,要換成上一則還是下一則由呼叫端決定。

/** 一次手勢的端點。`t` 是 `event.timeStamp`(毫秒)。 */
export type SwipePoint = { x: number; y: number; t: number };

/**
 * 水平位移的下限。太小的話,手指在文字上輕輕一抖就換掉整則筆記 —— 而使用者
 * 通常正在讀,不會知道自己做了什麼。
 */
export const SWIPE_MIN_X = 60;

/**
 * 水平要贏過垂直多少才算「橫滑」。**這一條是承重的**:筆記卡是要捲的,不能像
 * 2048 的棋盤那樣掛 `touch-action: none` 把捲動整個關掉(見 `routes/Play.tsx`),
 * 所以「這是捲動還是換頁」只能靠角度分。1.5 ≈ 34°,斜著滑一律讓給捲動。
 */
export const SWIPE_RATIO = 1.5;

/**
 * 左右螢幕邊緣的護欄。iOS Safari 從邊緣往內滑是「上一頁 / 下一頁」的返回手勢 ——
 * 搶了它,使用者會覺得返回壞掉,而那比沒有滑動換頁糟得多。
 */
export const SWIPE_EDGE = 24;

/**
 * 手勢時長的上限。這條同時擋掉**選字**:iOS 要長按約 500ms 才進入選取,之後
 * 拖曳放大鏡調整範圍的位移又長又慢,時間上跟一次快滑分得很開。
 * (呼叫端另外還會看 selection 收不收合 —— 兩層,因為選字被換頁打斷最傷。)
 */
export const SWIPE_MAX_MS = 700;

/**
 * 回傳手指的移動方向,不是「上一則 / 下一則」。
 *
 * @param width 視窗寬度,用來算右側邊緣護欄。
 */
export function swipeDirection(
	start: SwipePoint,
	end: SwipePoint,
	width: number,
): "left" | "right" | null {
	// 起點就在邊緣 —— 整個手勢讓給瀏覽器。
	if (start.x < SWIPE_EDGE || start.x > width - SWIPE_EDGE) return null;
	if (end.t - start.t > SWIPE_MAX_MS) return null;

	const dx = end.x - start.x;
	const dy = end.y - start.y;
	if (Math.abs(dx) < SWIPE_MIN_X) return null;
	if (Math.abs(dx) < Math.abs(dy) * SWIPE_RATIO) return null;

	return dx < 0 ? "left" : "right";
}

/**
 * 一個左右可捲容器在**起手當下**的狀態。捲動位置在手勢過程中會變,所以要在
 * touchstart 就量 —— 從表格中段拖到最右緣,`touchend` 時它已經到底了,那時再問
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
 * `.table-scroll`(`overflow-x:auto`,而表格 `min-width: 36rem`),`.tiptap pre`
 * 也是 `overflow-x-auto`。390px 上一張表必定捲得動 —— 使用者橫拖是要看右邊那幾欄,
 * 那一下又平又快又超過 60px,四道護欄一道都擋不住,筆記就被換掉、表格捲到哪裡也
 * 一起丟了。**角度分不出這兩件事,只有問「底下有沒有東西還捲得動」分得出來。**
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

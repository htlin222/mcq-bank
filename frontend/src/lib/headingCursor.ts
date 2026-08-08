// 手把在筆記標題之間移動的游標運算。
//
// 為什麼是 DOM 而不是 React state:NoteContent 的每個手風琴各自持有自己的
// `open`,刻意如此(巢狀、彼此獨立)。要用手把走訪「目前展開得到的標題」,
// 與其把那份狀態集中管理(會牽動整個元件的形狀),不如直接問 DOM ——
// **收合的區段不渲染子節點**,所以 DOM 裡存在的標題按鈕,定義上就是使用者
// 現在看得到的那些。展開一個區段,它的子標題自動進入走訪範圍,不必同步。
//
// 這裡只放可測的純運算;真正碰 DOM 的部分留在呼叫端。

export const HEADING_SELECTOR = "[data-note-heading]";

/**
 * 下一個游標位置。
 *
 * @param current 目前位置,-1 代表還沒開始走
 * @param total   目前看得到的標題數
 * @param delta   +1 往下、-1 往上
 * @returns 新位置;沒有標題時回 -1
 *
 * 刻意**不繞圈**:走到底再按就停在底,這樣長按十字鍵不會從尾巴跳回開頭 ——
 * 那在一份長筆記裡讀起來像是位置被弄丟了。
 */
export function nextHeadingIndex(
	current: number,
	total: number,
	delta: number,
): number {
	if (total <= 0) return -1;
	if (current < 0) return delta > 0 ? 0 : total - 1;
	return Math.min(total - 1, Math.max(0, current + delta));
}

/**
 * 左右切換筆記時的下一個 slot。
 *
 * @param slots  目前這題底下所有筆記的 slot,依顯示順序
 * @param active 目前這則的 slot
 * @param delta  +1 下一則、-1 上一則
 *
 * 這裡**會繞圈**:筆記通常只有兩三則,繞回去比停在邊界自然,而且不會讓人
 * 以為按鍵沒反應。
 */
export function nextSlot(
	slots: number[],
	active: number,
	delta: number,
): number {
	if (slots.length === 0) return active;
	const at = slots.indexOf(active);
	if (at < 0) return slots[0];
	const n = slots.length;
	return slots[(((at + delta) % n) + n) % n];
}

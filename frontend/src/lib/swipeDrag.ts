// 卡片跟著手指走的那一層。`lib/swipeNav.ts` 回答「這一下算不算滑動」,這裡回答
// 「現在該把卡片畫在哪裡,以及放手要不要換過去」。
//
// 為什麼要分兩個檔案:`swipeNav` 的判準是**放手之後**看整段位移,而這裡每一幀都要
// 回答一次。合在一起的話,`SWIPE_MAX_MS` 那種只在結尾成立的規則會被每幀套用一次
// —— 拖超過 700ms 的瞬間卡片會自己彈回去,而手指還按著。
//
// ⚠️ **時間上限在這一層不存在,而那是刻意的。** 它原本的用途是擋選字(iOS 長按
// 約 500ms 才進選取),但直接操作之下「慢慢拖過臨界點」是正常操作 —— 用時間擋會
// 讓一個正確的手勢無聲失敗。選字改由 `lockSelectionBlocked`(見 hooks)在**鎖定
// 手勢的那一刻**看 selection 收不收合,那是更準的訊號:真的在選字時,那時一定有
// 一段非收合的選取。

/** 手指要移動多少才認定「這是一次橫向拖曳」並接管手勢。 */
export const LOCK_PX = 8;

/**
 * 放手就換過去的臨界距離。
 *
 * 跟著螢幕寬度走(22%),但夾在 56–96px:小螢幕上按比例會小到手一抖就換,
 * 大螢幕上會遠到要橫跨半個畫面。
 */
export function commitThreshold(width: number): number {
	return Math.min(96, Math.max(56, width * 0.22));
}

/**
 * 甩一下就換過去的速度(px/ms)。Tinder 那種手感的一半來自這裡 —— 只看距離的話,
 * 快速輕甩會因為位移不夠而彈回去,而那正是使用者覺得「沒反應」的時候。
 */
export const FLICK_VELOCITY = 0.5;
/** 但再快也要真的動過,否則點一下的手抖會被當成甩。 */
export const FLICK_MIN_PX = 24;

/**
 * 卡片實際要位移多少 —— 橡皮筋。
 *
 * 臨界點之前 1:1 跟著手指(直接操作要能對得上手指,不然會覺得黏);超過之後
 * 逐漸變重,位移趨近 `threshold + limit`。**變重本身就是回饋**:使用者感覺得到
 * 「已經到了」,不必再畫一個提示。
 */
export function dampedOffset(dx: number, width: number): number {
	const t = commitThreshold(width);
	const sign = dx < 0 ? -1 : 1;
    const abs = Math.abs(dx);
	if (abs <= t) return dx;
	// 超過的部分開根號衰減,上限 limit。
	const limit = t * 0.9;
	const over = abs - t;
	const damped = limit * (1 - 1 / (1 + over / limit));
	return sign * (t + damped);
}

/** 放手的當下,要不要換過去。 */
export function shouldCommit(o: {
	dx: number;
	dtMs: number;
	width: number;
}): boolean {
	const abs = Math.abs(o.dx);
	if (abs >= commitThreshold(o.width)) return true;
	// 甩:速度夠快而且真的動過。dtMs 可能是 0(同一毫秒內的合成事件),除以 0 會
	// 得到 Infinity 而讓每一次點擊都變成「甩」——所以先擋掉。
	if (o.dtMs <= 0) return false;
	return abs >= FLICK_MIN_PX && abs / o.dtMs >= FLICK_VELOCITY;
}

/**
 * 換過去的時候,卡片要飛到哪裡。整個畫面寬 + 一點,確保完全離開視野 ——
 * 停在邊緣會留下一條看得見的殘影。
 */
export function flyOutOffset(dx: number, width: number): number {
	return dx < 0 ? -(width + 40) : width + 40;
}

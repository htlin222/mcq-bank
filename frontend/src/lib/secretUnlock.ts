// 連點解鎖的狀態機(Android「開發者選項」那招)。
//
// 純函式,**不 import 任何東西** —— 才進得了 `node --test`(同 lib/years.ts、
// lib/questionProgress.ts 那條)。React 那一側在 hooks/useSecretTap.ts。

/** 要點幾下。7 是 Android 的慣例,大家有現成的心智模型。 */
export const TAPS_REQUIRED = 7;

/**
 * 兩下之間最長可以隔多久。
 *
 * ⚠️ 1500ms 是刻意放寬的,常見的做法是 400–600ms。這個站的重度使用者在 BOOX
 * 電子紙上,而 e-ink 的整頁刷新動輒兩三百毫秒 —— 使用者會「等畫面反應」才點
 * 下一下。窗口太窄的話,他們每次都在第三、四下斷掉,而症狀是「這招沒有用」,
 * 不是「我點太慢」。誤觸成本則趨近於零:標題不是按鈕,沒有人會連戳七下。
 */
export const TAP_WINDOW_MS = 1500;

export type TapState = {
	/** 目前連續點了幾下(已含這一下)。 */
	count: number;
	/** 上一下的時間戳。 */
	at: number;
};

export const INITIAL_TAP_STATE: TapState = { count: 0, at: 0 };

export type TapResult = {
	state: TapState;
	/** 這一下是不是剛好湊滿。只有湊滿的那一下是 true,第 8 下不會再是。 */
	fired: boolean;
	/** 還差幾下。湊滿或還沒開始累積時是 0。 */
	remaining: number;
};

/**
 * 收到一下點擊。回傳新狀態 —— 呼叫端只要看 `fired`。
 *
 * 超過窗口就從 1 重新算(不是歸零):使用者停頓之後的那一下,是新一輪的第一下,
 * 而不是被丟掉的一下。歸零的話他會覺得「點了沒反應」。
 */
export function tap(prev: TapState, now: number): TapResult {
	const fresh = now - prev.at <= TAP_WINDOW_MS;
	const count = fresh ? prev.count + 1 : 1;
	if (count >= TAPS_REQUIRED) {
		return { state: INITIAL_TAP_STATE, fired: true, remaining: 0 };
	}
	return { state: { count, at: now }, fired: false, remaining: TAPS_REQUIRED - count };
}

/**
 * 從第幾下開始給提示。
 *
 * 太早提示等於把秘密寫在畫面上(隨手點兩下標題的人就看到了);太晚則是在使用者
 * 已經要放棄的時候才出現。第 3 下之後才講,那時他已經是刻意在點了。
 */
export const HINT_AFTER = 3;

export function hintFor(state: TapState): string | null {
	if (state.count < HINT_AFTER) return null;
	return `還差 ${TAPS_REQUIRED - state.count} 下`;
}

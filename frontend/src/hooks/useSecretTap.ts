// 連點標題解鎖隱藏年份。狀態機在 lib/secretUnlock.ts(純函式,有測試),
// 這裡只負責接線與提示文字。
//
// 兩頁共用(複習模式、全真作答),而且**解鎖是全站的** —— 在其中一頁點開之後
// 另一頁也看得到。各頁各自記一份的話,使用者會以為「複習點過了為什麼模擬考
// 還沒有」,而那個落差沒有任何地方解釋得了。

import { useCallback, useRef, useState } from "react";
import {
	INITIAL_TAP_STATE,
	hintFor,
	tap,
	type TapState,
} from "../lib/secretUnlock";
import { toggleHiddenYears } from "../lib/unlockedYears";

export type SecretTap = {
	/** 掛在標題上。標題不是按鈕,所以只掛 onClick,不加 role/tabIndex。 */
	onClick: () => void;
	/** 目前要顯示的訊息(提示或結果),沒有就是 null。 */
	message: string | null;
};

/**
 * @param onUnlockChange 解鎖狀態變了 —— 呼叫端要重抓年份清單。
 */
export function useSecretTap(onUnlockChange: () => void): SecretTap {
	const state = useRef<TapState>(INITIAL_TAP_STATE);
	const [message, setMessage] = useState<string | null>(null);
	const timer = useRef<number | undefined>(undefined);

	const show = useCallback((text: string | null, ms: number) => {
		setMessage(text);
		window.clearTimeout(timer.current);
		if (text !== null) {
			// ⚠️ 訊息留久一點。電子紙整頁刷新要兩三百毫秒,常見的「閃 1.5 秒」在
			// 那上面很可能整段沒被畫出來 —— 使用者會覺得這招沒有反應。
			timer.current = window.setTimeout(() => setMessage(null), ms);
		}
	}, []);

	const onClick = useCallback(() => {
		const r = tap(state.current, Date.now());
		state.current = r.state;
		if (r.fired) {
			const { unlocked, years } = toggleHiddenYears();
			onUnlockChange();
			show(
				unlocked
					? `已顯示民國 ${years.join("、")} 年`
					: `已隱藏民國 ${years.join("、")} 年`,
				6000,
			);
			return;
		}
		show(hintFor(r.state), 4000);
	}, [onUnlockChange, show]);

	return { onClick, message };
}

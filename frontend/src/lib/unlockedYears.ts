// 使用者解鎖了哪些隱藏年份。localStorage-only。
//
// 為什麼不進 D1:這是介面偏好,不是帳號狀態 —— 掉了就再點七下,而放進 /api/me
// 會讓一個純視覺的設定多一趟請求與一次 migration。同 lib/theme.ts 的判準。

import { yearsToUnlock } from "./years";

const KEY = "unlocked-years";

/** SSR / node 環境下沒有 localStorage;讀不到就當作沒解鎖。 */
function safeGet(): string | null {
	try {
		return typeof localStorage === "undefined" ? null : localStorage.getItem(KEY);
	} catch {
		return null;
	}
}

export function loadUnlockedYears(): Set<number> {
	const raw = safeGet();
	if (!raw) return new Set();
	try {
		const arr = JSON.parse(raw);
		return new Set(Array.isArray(arr) ? arr.filter((n) => typeof n === "number") : []);
	} catch {
		return new Set();
	}
}

function save(set: Set<number>): void {
	try {
		if (typeof localStorage === "undefined") return;
		if (set.size === 0) localStorage.removeItem(KEY);
		else localStorage.setItem(KEY, JSON.stringify([...set]));
	} catch {
		/* 無痕模式 / 配額滿 —— 解鎖只是這一次有效,不值得為它報錯 */
	}
}

/**
 * 切換隱藏年份的顯示,回傳切換後是「顯示」還是「隱藏」。
 *
 * 做成 toggle 而不是只能開:沒有這個的話,解鎖之後就沒有路可以關回去,而畫面上
 * 又不能放一顆「隱藏」按鈕(那等於把秘密寫出來)。同一個手勢兩個方向,使用者不必
 * 記第二件事。
 */
export function toggleHiddenYears(): { unlocked: boolean; years: number[] } {
	const years = yearsToUnlock();
	const cur = loadUnlockedYears();
	const on = years.every((y) => cur.has(y));
	if (on) for (const y of years) cur.delete(y);
	else for (const y of years) cur.add(y);
	save(cur);
	return { unlocked: !on, years };
}

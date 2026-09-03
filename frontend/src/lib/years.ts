// 哪些年份要出現在畫面上。
//
// 單一來源:每個列年份的地方都走這裡,不要各自 filter —— 漏掉一處的症狀是
// 「某一頁還看得到那一年」,而使用者不會知道那是漏改而不是刻意的。
//
// 這個檔刻意**不 import 任何東西**(連 ./api 都不行)—— 那會讓它在
// `node --test` 底下載不起來。抓資料的在 lib/yearsApi.ts,存解鎖狀態的在
// lib/unlockedYears.ts。
//
// ⚠️ **這不是權限邊界。** /year/103 與 /q/103-018 現在就打得開,API 也讀得到,
// 任何登入的人只要知道網址就看得到。這一層做的是整理版面 —— 讓一個只有 42 題
// 的年份不要混在完整年份中間,不是把資料收回去。真要擋得做在 Worker。

export type YearMeta = { year: number; count: number };

/**
 * 預設不列在年份清單裡的年份。
 *
 * - 103:題庫只收了 42 題(其餘 58 題沒有來源)。放在清單上會讓人以為「這年考
 *   42 題」,而模擬考選它出來的卷子也只有 42 題。
 *
 * 用集合而不是單一值,是因為下一個半匯入的年份會用到同一套 —— 布林旗標會逼
 * 那時候的人重寫這裡。
 */
export const HIDDEN_YEARS: ReadonlySet<number> = new Set([103]);

/** 隱藏年份各自的原因,解鎖後顯示在卡片上。看得到就不會有人以為那是完整的一年。 */
export const HIDDEN_YEAR_NOTE: Readonly<Record<number, string>> = {
	103: "題庫僅收錄 42 題(原卷 100 題)",
};

export function isHiddenYear(year: number): boolean {
	return HIDDEN_YEARS.has(year);
}

/** 這一年看不看得到。`unlocked` 是使用者已經解鎖的年份。 */
export function isYearVisible(year: number, unlocked?: ReadonlySet<number>): boolean {
	return !HIDDEN_YEARS.has(year) || unlocked?.has(year) === true;
}

export function visibleYears<T extends { year: number }>(
	rows: T[],
	unlocked?: ReadonlySet<number>,
): T[] {
	return rows.filter((r) => isYearVisible(r.year, unlocked));
}

/**
 * 這一次連點該解鎖哪些年份。
 *
 * 目前就是「全部的隱藏年份」—— 只有一個,分得更細沒有意義(YAGNI)。抽成函式是
 * 為了讓呼叫端不必知道 HIDDEN_YEARS 長什麼樣。
 */
export function yearsToUnlock(): number[] {
	return [...HIDDEN_YEARS];
}

// 抓年份清單。**兩支,不是一支** —— 呼叫端得自己回答「這一頁是要開始新東西,
// 還是在看已經做過的紀錄」。
//
// 103 年題庫只收了 42 題,所以不該再被當成新的學習目標;但正式站已經有 336 筆
// 作答、139 列進度、4 場模擬考、5 個收藏落在 103 上。把它從**紀錄類**頁面也藏
// 掉的話,那些東西會變成篩不到、但在未篩選的清單裡看得到的孤兒,而且「全部」的
// 數字對不起來。
//
//   fetchYears()     開始新東西 → 首頁年份卡、複習模式、模擬考、出卷頁
//                    (已解鎖的隱藏年份會一起回來)
//   fetchAllYears()  看紀錄 / 搜尋 → 錯題回顧與收藏、全文搜尋的年份篩選

import { api } from "./api";
import { loadUnlockedYears } from "./unlockedYears";
import { visibleYears, type YearMeta } from "./years";

export type { YearMeta };

const ENDPOINT = "/api/questions/_meta/years";

/** 可以拿來「開始新一輪」的年份 —— 濾掉不完整的年份,除非使用者解鎖過。 */
export async function fetchYears(): Promise<YearMeta[]> {
	return visibleYears(await api.get<YearMeta[]>(ENDPOINT), loadUnlockedYears());
}

/** 題庫裡真的存在的所有年份 —— 篩選既有紀錄時用,不然會篩不到自己做過的題。 */
export async function fetchAllYears(): Promise<YearMeta[]> {
	return api.get<YearMeta[]>(ENDPOINT);
}

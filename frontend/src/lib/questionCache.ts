import type { QuestionFull } from "../hooks/useQuestion";
import { api } from "./api";
import { createQuestionStore } from "./questionStore";

/**
 * 單題 payload 的應用層快取。`peek()` 同步可讀,所以預抓命中時換題完全不進
 * loading 狀態。失效由呼叫端掌握:存檔後 `set()` 覆寫、`reload({force})` 繞過 ttl。
 *
 * ttl 60s 是刻意的短命:詳解是共筆,別人可能剛改過。過期不代表丟掉 —— 仍然先把
 * 舊的畫出來(stale-while-revalidate),同時背景重抓。
 */
export const questionCache = createQuestionStore<QuestionFull>((id) =>
	api.get<QuestionFull>(`/api/questions/${id}`),
);

export type YearListItem = { id: string; number: number };

/**
 * 「同年度題目清單」—— 上一題/下一題就是靠它算出來的。以前每換一題都重抓一次,
 * 等於每次導覽多一趟 RTT,而且是**在題目載入之後**才發,所以 prev/next 按鈕會慢
 * 半拍才亮。一年的題目清單只有發布新年份時才變,快取五分鐘綽綽有餘。
 */
export const yearListCache = createQuestionStore<YearListItem[]>(
	(year) => api.get<YearListItem[]>(`/api/questions?year=${year}&limit=200`),
	{ max: 12, ttlMs: 5 * 60_000 },
);

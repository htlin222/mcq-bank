// 跨年份到期佇列的「下一張要給什麼」策略。純函式,沒有 D1 依賴。
//
// 順序是 learning → 到期/新卡交錯。「先清完到期再上新卡」會讓到期量大的日子
// 永遠碰不到新卡(引入速度歸零);「新卡優先」則會在中途放棄時把到期卡堆到
// 明天。learning 永遠插隊 —— 那是幾分鐘後就該再見的短期步驟,延後等於作廢。
export const DEFAULT_NEW_PER_DAY = 20;
export const NEW_EVERY = 4; // 每 3 張到期卡插 1 張新卡
const MAX_NEW_PER_DAY = 200;

export type QueueState = {
	served: number; // 本 session 已送出張數
	learning: number; // 現在可做的 learning/relearning
	dueReview: number; // 今天到期的 review 卡
	newAvailable: number; // 題庫中尚未建卡的題數
	newRemaining: number; // 今日新卡剩餘額度
};
export type NextKind = "learning" | "due" | "new" | null;

export function pickNextKind(s: QueueState): NextKind {
	if (s.learning > 0) return "learning";
	const canNew = s.newAvailable > 0 && s.newRemaining > 0;
	if (s.dueReview <= 0) return canNew ? "new" : null;
	if (canNew && (s.served + 1) % NEW_EVERY === 0) return "new";
	return "due";
}

export function remainingNewToday(
	introducedToday: number,
	limit: number,
): number {
	const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 0;
	return Math.max(0, cap - introducedToday);
}

export function parseNewLimit(raw: string | undefined): number {
	if (raw === undefined || raw === "") return DEFAULT_NEW_PER_DAY;
	const n = Number(raw);
	return Number.isFinite(n) && n >= 0
		? Math.min(MAX_NEW_PER_DAY, Math.floor(n))
		: DEFAULT_NEW_PER_DAY;
}

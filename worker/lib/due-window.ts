// 「今天」的日界。全員在台灣(UTC+8),與 review.ts 既有的 strftime '+8 hours'
// 慣例一致,不做 per-user 時區。日界預設凌晨 4 點(同 Anki 的 rollover):
// 熬夜讀到凌晨兩點時,佇列不該在午夜換一批。
export const TZ_OFFSET_MS = 8 * 60 * 60 * 1000;
export const DEFAULT_DAY_START_HOUR = 4;
const DAY_MS = 86_400_000;

export type DayWindow = { dayStart: number; dayEnd: number; dayKey: string };
export type DueLike = { due_at: number; state: number } | null;

export function clampHour(h: number): number {
	return Number.isFinite(h) && h >= 0 && h <= 23
		? Math.floor(h)
		: DEFAULT_DAY_START_HOUR;
}

export function dayWindow(
	now: number,
	opts: { dayStartHour?: number } = {},
): DayWindow {
	const shift =
		TZ_OFFSET_MS -
		clampHour(opts.dayStartHour ?? DEFAULT_DAY_START_HOUR) * 3_600_000;
	const dayIndex = Math.floor((now + shift) / DAY_MS);
	return {
		dayStart: dayIndex * DAY_MS - shift,
		dayEnd: (dayIndex + 1) * DAY_MS - shift,
		dayKey: new Date(dayIndex * DAY_MS).toISOString().slice(0, 10),
	};
}

// state: 0=New 1=Learning 2=Review 3=Relearning(ts-fsrs State enum)
// Review 卡用日級判定(今天稍晚到期今天就能做,同 Anki);learning/relearning
// 是幾分鐘後的短期步驟,只能到點才做,不可提前。
export function isDueToday(card: DueLike, now: number, w: DayWindow): boolean {
	if (!card || card.state === 0) return true;
	if (card.state === 1 || card.state === 3) return card.due_at <= now;
	return card.due_at <= w.dayEnd;
}

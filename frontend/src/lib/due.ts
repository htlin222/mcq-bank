// 跨年份到期佇列的共用型別 —— GET /api/review/due 的回傳,
// /due 頁、首頁 CTA 與複習頁 badge 共吃同一份。
export type DueSummary = {
  learning: number;
  due_review: number;
  new_available: number;
  new_remaining: number;
  new_introduced_today: number;
  new_limit: number;
  due_total: number;
  next_due_at: number | null;
  by_year: { year: number; due: number }[];
  day_start_hour: number;
  day_start: number;
  day_end: number;
};

export type DueKind = 'learning' | 'due' | 'new';

export const dueKindLabel: Record<DueKind, string> = {
  learning: '學習中',
  due: '到期',
  new: '新卡',
};

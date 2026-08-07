import { api } from './api';

// 答題狀態分析:個人作答長表的下載。伺服器端在 worker/routes/attempt-log.ts。

export type AttemptLogMeta = {
  /** 只包含這個人真的答過的年份,由新到舊。 */
  years: { year: number; n: number }[];
  total: number;
  first_at: number | null;
  last_at: number | null;
  max_rows: number;
};

export type AttemptLogFilters = {
  /** 空陣列 = 全部年份。 */
  years: number[];
  wrong_only: boolean;
  /** 'YYYY-MM-DD';空字串送出前會轉成 null。 */
  from: string | null;
  to: string | null;
};

export const EMPTY_FILTERS: AttemptLogFilters = {
  years: [],
  wrong_only: false,
  from: null,
  to: null,
};

/** 條件是不是「全部」—— UI 用它決定要不要顯示「清除條件」。 */
export function isDefaultFilters(f: AttemptLogFilters): boolean {
  return f.years.length === 0 && !f.wrong_only && !f.from && !f.to;
}

/** 'YYYY-MM-DD',用瀏覽器本地時區 —— 和 <input type="date"> 顯示的同一天。 */
export function localDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 「最近 N 天」含今天,所以起點是 N-1 天前。 */
export function lastNDays(n: number, today = new Date()): { from: string; to: string } {
  const start = new Date(today);
  start.setDate(start.getDate() - (n - 1));
  return { from: localDate(start), to: localDate(today) };
}

export function fetchAttemptLogMeta(): Promise<AttemptLogMeta> {
  return api.get<AttemptLogMeta>('/api/attempt-log/meta');
}

export function previewAttemptLog(f: AttemptLogFilters): Promise<{ count: number }> {
  return api.post<{ count: number }>('/api/attempt-log/preview', f);
}

export function downloadAttemptLog(f: AttemptLogFilters): Promise<void> {
  return api.download('/api/attempt-log/export', f);
}

// 自訂測驗 session 的顯示標籤。
//
// exam_sessions.year 對自訂測驗是 0 哨兵(SQLite 放寬不了 NOT NULL),
// 所以判斷種類一律看 kind,顯示層才把它翻成「自訂測驗」。

export type SessionLike = {
  year: number;
  kind?: 'year' | 'custom';
  filter_json?: string | null;
};

const STATUS_LABEL: Record<string, string> = {
  unseen: '未做過',
  wrong: '做錯過',
  correct: '曾答對',
  bookmarked: '已收藏',
};

/** 主標題:年度考回「民國 114」樣式的年份,自訂測驗回「自訂測驗」。 */
export function sessionTitle(s: SessionLike): string {
  return s.kind === 'custom' ? '自訂測驗' : String(s.year);
}

/**
 * 自訂測驗的條件摘要,例如「未做過 · 114,113 · 20 題」。
 * filter_json 缺失 / 壞掉一律回 null,呼叫端就只顯示「自訂」。
 */
export function describeFilters(filterJson: string | null | undefined): string | null {
  if (!filterJson) return null;
  let f: Record<string, unknown>;
  try {
    f = JSON.parse(filterJson) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!f || typeof f !== 'object') return null;

  const parts: string[] = [];
  const status = Array.isArray(f.status) ? (f.status as string[]) : [];
  if (status.length > 0) parts.push(status.map((s) => STATUS_LABEL[s] ?? s).join('/'));

  const years = Array.isArray(f.years) ? (f.years as number[]) : [];
  if (years.length > 0) parts.push(years.join(','));

  const groups = Array.isArray(f.groups) ? (f.groups as string[]) : [];
  if (groups.length > 0) parts.push(groups.join(','));

  const tags = Array.isArray(f.tags) ? (f.tags as string[]) : [];
  if (tags.length > 0) parts.push(tags.map((t) => '#' + t).join(' '));

  if (typeof f.count === 'number') parts.push(`${f.count} 題`);

  return parts.length > 0 ? parts.join(' · ') : null;
}

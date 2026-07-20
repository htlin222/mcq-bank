// 配速統計 — 全部純函式,無 D1 依賴,方便直接單測。

/** 全體中位數的最小作答人數。20 人的讀書會裡,3 個人的「中位數」
 *  等於點名,故低於門檻一律回 null(呼叫端傳空陣列即可)。 */
export const MIN_COHORT = 5;

/** 線性插值百分位。會複製後排序,不依賴輸入順序;空陣列回 null。 */
export function percentile(xs: number[], p: number): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const idx = (s.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return s[lo];
  return s[lo] + (idx - lo) * (s[hi] - s[lo]);
}

export function median(xs: number[]): number | null {
  return percentile(xs, 0.5);
}

export type PacingSplit = {
  firstHalfAvg: number;
  secondHalfAvg: number;
  /** 後段相對前段慢了幾 %(正數 = 變慢);前段為 0 時無意義,回 null。 */
  deltaPct: number | null;
  n: number;
};

/** 前後半段配速對比。**輸入必須是作答順序**,本函式不排序。
 *  奇數題時中間那題歸前段(mid = ceil(n/2))。 */
export function pacingSplit(xs: number[]): PacingSplit | null {
  const n = xs.length;
  if (n < 2) return null;
  const mid = Math.ceil(n / 2);
  const avg = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
  const firstHalfAvg = avg(xs.slice(0, mid));
  const secondHalfAvg = avg(xs.slice(mid));
  return {
    firstHalfAvg,
    secondHalfAvg,
    deltaPct: firstHalfAvg === 0 ? null : Math.round((secondHalfAvg / firstHalfAvg - 1) * 100),
    n,
  };
}

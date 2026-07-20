// 選項分布統計 — 純函式,無 D1 依賴,方便直接單測。
//
// 匿名門檻沿用 worker/lib/pacing.ts 的 MIN_COHORT(同一個「20 人讀書會裡
// 少於幾人就等於點名」的判斷,不另立第二個常數)。

export type Vote = { user: string; chosen: string | null; at: number };

export type ChoiceStats = {
  responders: number;
  counts: Record<string, number> | null;
  pct: Record<string, number> | null;
  suppressed: boolean;
};

/**
 * 把逐筆作答折成「一人一票、取最新」的選項分布。
 *
 * - 同一 user 出現多次時取 `at` 較大者;`at` 相同時後出現者勝
 *   (呼叫端把較可信的來源放後面)。
 * - `chosen` 為 null / 空白 / 不在 `letters` 內的值一律忽略,
 *   不計入 responders。
 * - 人數低於 `minResponders` 時只回人數,不回任何 per-option 數字。
 */
export function tallyChoices(
  votes: Vote[],
  opts: { letters: string[]; minResponders: number },
): ChoiceStats {
  const allowed = new Set(opts.letters);
  const latest = new Map<string, { chosen: string; at: number }>();
  for (const v of votes) {
    const c = (v.chosen ?? '').trim().toUpperCase();
    if (!c || !allowed.has(c)) continue;
    const prev = latest.get(v.user);
    if (prev && prev.at > v.at) continue;
    latest.set(v.user, { chosen: c, at: v.at });
  }

  const responders = latest.size;
  if (responders < opts.minResponders) {
    return { responders, counts: null, pct: null, suppressed: true };
  }

  const counts: Record<string, number> = {};
  for (const L of opts.letters) counts[L] = 0;
  for (const { chosen } of latest.values()) counts[chosen] += 1;

  const pct: Record<string, number> = {};
  for (const L of opts.letters) {
    pct[L] = Math.round((counts[L] * 1000) / responders) / 10;
  }
  return { responders, counts, pct, suppressed: false };
}

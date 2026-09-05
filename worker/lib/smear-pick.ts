/**
 * 抹片練習題目挑選:依主題比例(largest remainder 分配)從題庫抽出 n 題,
 * 缺額由其他主題回填,並盡量避開上一場考過的題目。
 *
 * 這裡刻意不依賴任何外部狀態(D1、Workers 環境) —— 純函式,方便單元測試,
 * 也讓呼叫端(worker route)自己決定題庫從哪裡查。
 */

export interface PoolItem {
  id: string;
  topic: string;
}

/**
 * 把整數 n 依 weights 的比例分配成整數配額,總和恰為 n。
 *
 * 作法:每類先取 floor(n * w / totalWeight),此時總和必然 <= n(因為
 * floor 只會減少,不會增加);把差額依「小數部分」由大到小分給對應的類,
 * 各 +1 直到補滿。小數部分相同時,依 key 字母序決定順序 —— 純粹是為了
 * 讓結果可重現(same input → same output),不是說這個順序有什麼特別意義。
 *
 * weights 不要求總和為 1(容許浮點誤差或使用者手滑),一律先除以總和正規化。
 */
export function largestRemainder(
  n: number,
  weights: Record<string, number>,
): Record<string, number> {
  const keys = Object.keys(weights);
  const result: Record<string, number> = {};
  for (const k of keys) result[k] = 0;

  if (n <= 0 || keys.length === 0) return result;

  const totalWeight = keys.reduce((sum, k) => sum + Math.max(0, weights[k] ?? 0), 0);

  if (totalWeight <= 0) {
    // 沒有任何正權重可以依比例分配 —— 退化成平均分配,而不是整批送給某一類
    // 或直接回傳全 0(那會讓呼叫端誤以為題庫是空的)。
    const equal: Record<string, number> = {};
    for (const k of keys) equal[k] = 1;
    return largestRemainder(n, equal);
  }

  const exact: Record<string, number> = {};
  let flooredTotal = 0;
  for (const k of keys) {
    const w = Math.max(0, weights[k] ?? 0);
    const e = (n * w) / totalWeight;
    exact[k] = e;
    const f = Math.floor(e);
    result[k] = f;
    flooredTotal += f;
  }

  let remainder = n - flooredTotal;
  if (remainder <= 0) return result;

  const order = [...keys].sort((a, b) => {
    const fa = exact[a] - result[a];
    const fb = exact[b] - result[b];
    if (fb !== fa) return fb - fa;
    return a < b ? -1 : a > b ? 1 : 0;
  });

  // 正常情況下一輪就分完(remainder < keys.length),多包一層 while 只是
  // 防浮點極端狀況(例如 remainder 意外大於 keys.length)不會漏掉名額。
  while (remainder > 0) {
    for (const k of order) {
      if (remainder <= 0) break;
      result[k] += 1;
      remainder -= 1;
    }
  }

  return result;
}

export function fisherYatesShuffle<T>(items: T[], rng: () => number): T[] {
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = a[i];
    a[i] = a[j];
    a[j] = tmp;
  }
  return a;
}

/**
 * 從 pool 裡挑出 n 題,依 topicWeights 的比例分配,盡量避開 exclude
 * (通常是上一場練習考過的題號),回傳題目 id 陣列。
 *
 * 三個保證,依優先順序:
 *   1. 回傳長度 = min(n, 題庫不重複題數) —— 題庫不夠就給全部,不重複湊數。
 *   2. 每一類的配額不足時,缺額回填給其他類 —— 不會因為某類題數不足就
 *      讓總數少於 n(除非整個題庫都不夠)。
 *   3. 盡量避開 exclude;只有在扣掉 exclude 後仍然湊不滿 n 時,才會
 *      動用 exclude 裡的題目 —— 湊滿 n 優先於「完全不重複上一場」。
 */
export function pickSmearSet(
  pool: PoolItem[],
  n: number,
  topicWeights: Record<string, number>,
  exclude: Set<string>,
  rng: () => number,
): string[] {
  if (n <= 0) return [];

  // 以 id 去重(同一題若在 pool 裡出現兩次只算一題可選)。
  const byId = new Map<string, PoolItem>();
  for (const item of pool) {
    if (!byId.has(item.id)) byId.set(item.id, item);
  }
  const allItems = [...byId.values()];
  if (allItems.length === 0) return [];

  const targetN = Math.min(n, allItems.length);

  const byTopic = new Map<string, PoolItem[]>();
  for (const item of allItems) {
    const list = byTopic.get(item.topic);
    if (list) list.push(item);
    else byTopic.set(item.topic, [item]);
  }

  const quotas = largestRemainder(targetN, topicWeights);

  const selected: string[] = [];
  const selectedSet = new Set<string>();

  for (const topic of Object.keys(quotas)) {
    const quota = quotas[topic];
    if (quota <= 0) continue;
    const candidates = (byTopic.get(topic) ?? []).filter(
      (item) => !exclude.has(item.id) && !selectedSet.has(item.id),
    );
    const shuffled = fisherYatesShuffle(candidates, rng);
    for (const item of shuffled.slice(0, quota)) {
      selected.push(item.id);
      selectedSet.add(item.id);
    }
  }

  let remaining = targetN - selected.length;

  if (remaining > 0) {
    // 缺額回填(第一輪):不管原本分到哪一類的配額,只要還沒被選過、
    // 也不在 exclude 裡,都是候選。
    const backfill = allItems.filter(
      (item) => !exclude.has(item.id) && !selectedSet.has(item.id),
    );
    const shuffled = fisherYatesShuffle(backfill, rng);
    for (const item of shuffled) {
      if (remaining <= 0) break;
      selected.push(item.id);
      selectedSet.add(item.id);
      remaining -= 1;
    }
  }

  if (remaining > 0) {
    // 缺額回填(第二輪):非 exclude 的候選也不夠了,才動用 exclude —— 湊滿
    // n 題優先於「完全不重複上一場」。
    const lastResort = allItems.filter((item) => !selectedSet.has(item.id));
    const shuffled = fisherYatesShuffle(lastResort, rng);
    for (const item of shuffled) {
      if (remaining <= 0) break;
      selected.push(item.id);
      selectedSet.add(item.id);
      remaining -= 1;
    }
  }

  if (selected.length !== selectedSet.size) {
    throw new Error('pickSmearSet produced duplicate ids — this is a bug, not bad input');
  }

  return selected;
}

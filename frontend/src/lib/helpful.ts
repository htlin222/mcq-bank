// 「有幫助」排序 —— 與 worker/lib/helpful.ts 同步的副本。
//
// 為什麼是副本而不是 import:frontend/tsconfig.json 的 include 只有 "src",
// 跨到 worker/ 會讓 vite build 與 tsc 都失效。行為權威在 worker 端
// (worker/lib/helpful.test.ts);改動請兩邊一起改。同樣的處理方式見
// ChatProvider.tsx 對 emoji palette 的既有做法。

export type Rankable = {
  id: string;
  helpful_count: number;
  created_at: number;
  adopted?: boolean | number; // D1 的 EXISTS 回 0/1,前端 state 用 boolean —— 兩者都收
};

const DAY = 86_400_000;
// 弱衰減:讀書會討論以「週」為生命週期,不需要 HN 的 1.8。
const GRAVITY = 0.3;

export function helpfulScore(
  r: Pick<Rankable, 'helpful_count' | 'created_at'>,
  now: number
): number {
  if (r.helpful_count <= 0) return 0;
  const ageDays = Math.max(0, (now - r.created_at) / DAY);
  return r.helpful_count / Math.pow(ageDays + 2, GRAVITY);
}

export function rankByHelpful<T extends Rankable>(items: T[], now: number): T[] {
  return [...items].sort((a, b) => {
    if (!!a.adopted !== !!b.adopted) return a.adopted ? -1 : 1;
    const d = helpfulScore(b, now) - helpfulScore(a, now);
    return d !== 0 ? d : a.created_at - b.created_at;
  });
}

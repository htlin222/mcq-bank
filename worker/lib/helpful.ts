// 「有幫助」排序。純函式:不碰 D1、不讀 Date.now()(now 由呼叫端傳入),
// 所以可以在 node:test 下直接測。
//
// 前端有一份同內容的副本 frontend/src/lib/helpful.ts —— frontend/tsconfig.json
// 的 include 只有 "src",無法跨界 import。兩檔需同步修改;行為權威在這裡
// (worker/lib/helpful.test.ts)。

export type Rankable = {
  id: string;
  helpful_count: number;
  created_at: number;
  adopted?: boolean;
};

const DAY = 86_400_000;
// 弱衰減:讀書會討論以「週」為生命週期,不需要 HN 的 1.8。沒有衰減時
// 最早發的留言會永久霸榜,後來更好的回答永無出頭日。
const GRAVITY = 0.3;

export function helpfulScore(
  r: Pick<Rankable, 'helpful_count' | 'created_at'>,
  now: number
): number {
  if (r.helpful_count <= 0) return 0;
  // 夾在 0:未來時戳(時鐘偏移)不該換到超額分數。
  const ageDays = Math.max(0, (now - r.created_at) / DAY);
  return r.helpful_count / Math.pow(ageDays + 2, GRAVITY);
}

export function rankByHelpful<T extends Rankable>(items: T[], now: number): T[] {
  return [...items].sort((a, b) => {
    // 被社群採納者(該題 promoted 挑戰的提案人)強制置頂 —— 已用行動認證過。
    if (!!a.adopted !== !!b.adopted) return a.adopted ? -1 : 1;
    const d = helpfulScore(b, now) - helpfulScore(a, now);
    return d !== 0 ? d : a.created_at - b.created_at; // 同分比時間,早者在前
  });
}

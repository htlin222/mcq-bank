/**
 * 抹片練習「看選項」提示：從正解的同一個 topic 裡挑干擾項，同 topic 候選
 * 不足時從其他 topic 回填 —— 沿用 smear-pick.ts 的 largest-remainder 回填
 * 精神,但這裡只挑固定數量的干擾項,不是按比例分配題數,所以另開一支純函式
 * 而不是重用 pickSmearSet()。
 *
 * 正解與干擾項的組合必須在伺服器產生（見呼叫端 worker/routes/smear.ts 的
 * mc-options 端點）——這支函式本身不碰網路/D1，純粹是給定候選池挑幾個出來。
 */
import { fisherYatesShuffle } from "./smear-pick.ts";

export interface McqCandidate {
  id: string;
  topic: string;
  label: string;
}

/**
 * 從 pool 裡挑 count 個干擾項(不含 correct 自己)。優先同 topic,不足則從
 * 其他 topic 回填。回傳的是 label(不是 id)——呼叫端只需要顯示用的文字。
 */
export function pickMcqDistractors(
  correct: McqCandidate,
  pool: McqCandidate[],
  count: number,
  rng: () => number,
): string[] {
  if (count <= 0) return [];

  const byId = new Map<string, McqCandidate>();
  for (const item of pool) {
    if (item.id !== correct.id && !byId.has(item.id)) byId.set(item.id, item);
  }
  const all = [...byId.values()];

  const sameTopic = all.filter((i) => i.topic === correct.topic);
  const otherTopic = all.filter((i) => i.topic !== correct.topic);

  const picked: McqCandidate[] = fisherYatesShuffle(sameTopic, rng).slice(0, count);
  const remaining = count - picked.length;
  if (remaining > 0) {
    picked.push(...fisherYatesShuffle(otherTopic, rng).slice(0, remaining));
  }

  return picked.map((i) => i.label);
}

/**
 * 正解 + 干擾項,洗牌後回傳給前端顯示的完整選項清單(不帶任何「哪一個是
 * 正解」的資訊 —— 呼叫端只能拿到這個陣列本身)。
 */
export function pickMcqOptions(
  correct: McqCandidate,
  pool: McqCandidate[],
  rng: () => number,
  distractorCount = 4,
): string[] {
  const distractors = pickMcqDistractors(correct, pool, distractorCount, rng);
  return fisherYatesShuffle([correct.label, ...distractors], rng);
}

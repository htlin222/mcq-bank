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

export interface DxTermLike {
  text: string;
  tier: string;
  form: string;
}

/**
 * 「看選項」正解選項的顯示文字,必須挑一個**能通過 gradeSmear() 判成 full**
 * 的字串 —— 不能直接用 smear_dx.canonical_long。
 *
 * `canonical_long` 是給人看的完整名稱,常帶括號補充(如
 * "acute lymphoblastic leukemia, L3 (Burkitt-type)"),但 gradeSmear() 只比對
 * smear_terms 裡登記的詞,不認 canonical_long 本身。字數不一致時,原封不動把
 * canonical_long 塞進選項會讓使用者選到「顯示的正解」卻被判成 miss。
 *
 * 優先挑 full 級 + form='long'(比縮寫更適合當選項文字),其次任何 full 級,
 * 最後才退回 canonical_long(理論上每個診斷都至少有一個 full 級詞,這一步只是
 * 安全網)。
 */
export function pickCorrectOptionLabel(terms: DxTermLike[], canonicalLong: string): string {
  const full = terms.filter((t) => t.tier === "full");
  const long = full.find((t) => t.form === "long");
  if (long) return long.text;
  if (full.length > 0) return full[0].text;
  return canonicalLong;
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

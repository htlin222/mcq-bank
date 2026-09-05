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
  /**
   * smear_dx.qtype：'cell'（這是什麼細胞）或 'disease'（這是什麼疾病）。
   * 同一個 topic 底下常常混著兩種（例如 myeloid 同時有骨髓芽細胞這種細胞
   * 辨識題,也有 AML 這種疾病名題),干擾項分層要看 qtype 才不會把疾病名
   * 混進細胞辨識題(一眼就能排除,削弱提示的鑑別力)。
   */
  qtype: string;
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
 * 依序從每一層候選池裡湊到 count 個,前面的層洗牌後優先取,湊不滿才往下一層
 * 借 —— 沿用 pickSmearSet() 的「優先嚴格匹配,不足才漸進放寬」精神。
 */
function pickFromTiers(
  tiers: McqCandidate[][],
  count: number,
  rng: () => number,
): McqCandidate[] {
  const picked: McqCandidate[] = [];
  for (const tier of tiers) {
    const remaining = count - picked.length;
    if (remaining <= 0) break;
    picked.push(...fisherYatesShuffle(tier, rng).slice(0, remaining));
  }
  return picked;
}

/**
 * 從 pool 裡挑 count 個干擾項(不含 correct 自己)。分三層,依序放寬:
 *
 *   1. 同 topic + 同 qtype  ——  最嚴格,同時是干擾項鑑別力最強的一層。
 *   2. 同 topic + 任意 qtype ——  topic 不足時的第一層回填。
 *   3. 任意 topic           ——  最後的安全網,同舊版的跨 topic 回填。
 *
 * 不足則逐層往下借,不靜默少於名額。回傳的是 label(不是 id)——呼叫端只
 * 需要顯示用的文字。
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

  const sameTopicSameQtype = all.filter(
    (i) => i.topic === correct.topic && i.qtype === correct.qtype,
  );
  const sameTopicOtherQtype = all.filter(
    (i) => i.topic === correct.topic && i.qtype !== correct.qtype,
  );
  const otherTopic = all.filter((i) => i.topic !== correct.topic);

  const picked = pickFromTiers([sameTopicSameQtype, sameTopicOtherQtype, otherTopic], count, rng);

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

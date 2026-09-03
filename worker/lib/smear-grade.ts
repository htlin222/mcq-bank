/**
 * 抹片作答判定。
 *
 * 四層:full(1 分)/ half(0.5)/ lay(俗名,0 分但明講正解)/ miss。
 *
 * ⚠️ 比對順序必須是 full → half → lay。反過來的話 `tear drop` 會被某個寬鬆
 *    規則先吃掉,而症狀是「這個功能好像不太在意我寫什麼」。
 *
 * ⚠️ Levenshtein ≤1 的容錯只給長度 ≥5 的字。AML 與 ALL 的距離正好是 1 ——
 *    對短縮寫開容錯等於把「答錯」判成「拼錯」,而這個題庫滿滿都是三個字母的
 *    縮寫(AML/ALL/CML/CLL/MDS/MPN)。
 */
export type Tier = 'full' | 'half' | 'lay';
export interface AcceptedTerm { text: string; tier: Tier }
export interface SpellingError { typed: string; expected: string }
export interface Grade {
  tier: Tier | 'miss';
  score: number;
  matched: string | null;
  canonical: string | null;
  spellingErrors: SpellingError[];
}

const TIER_ORDER: Tier[] = ['full', 'half', 'lay'];
const TIER_SCORE: Record<Tier, number> = { full: 1, half: 0.5, lay: 0 };
const FUZZY_MIN_LEN = 5;

// 已知會被誤判成拼字錯的反義詞對 —— Levenshtein ≤1 但臨床意義相反。
// 不是要窮舉所有可能,只擋已知會撞到的:microcytic/macrocytic 差一個字元
// 但一個是小球性、一個是大球性貧血,答錯字母不是「拼錯」是「答錯」。
//
// osteoblast/osteoclast 與 AMMoL/CMMoL 是從 scripts/smear/data/dx.json 實際
// 題庫裡逐字掃出來的 —— 前者是造骨/蝕骨兩種相反功能的細胞(dx_id: osteoblast
// / osteoclast,各自獨立成題),後者是急性/慢性骨髓單核球性白血病的縮寫
// (AMMoL 恰好 5 字元,卡在 FUZZY_MIN_LEN 的邊界上,長度閘門救不了它)。
const DANGEROUS_PAIRS: [string, string][] = [
  ['microcytic', 'macrocytic'],
  ['microcyte', 'macrocyte'],
  ['hypochromic', 'hyperchromic'],
  ['hypocellular', 'hypercellular'],
  ['hypoplastic', 'hyperplastic'],
  ['osteoblast', 'osteoclast'],
  ['ammol', 'cmmol'],
];

function isDangerousPair(a: string, b: string): boolean {
  return DANGEROUS_PAIRS.some(([x, y]) => (a === x && b === y) || (a === y && b === x));
}

export function normalizeTerm(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')   // 去變音符:Döhle → dohle
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[-–—_/]+/g, ' ')
    .replace(/[.,;:!?()[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    prev = cur;
  }
  return prev[n];
}

/** 回 null = 不匹配;回陣列 = 匹配(可能帶拼字錯) */
function matchWords(typed: string[], expected: string[]): SpellingError[] | null {
  if (typed.length !== expected.length) return null;
  const errs: SpellingError[] = [];
  for (let i = 0; i < typed.length; i++) {
    if (typed[i] === expected[i]) continue;
    if (
      expected[i].length >= FUZZY_MIN_LEN &&
      levenshtein(typed[i], expected[i]) <= 1 &&
      !isDangerousPair(typed[i], expected[i])
    ) {
      errs.push({ typed: typed[i], expected: expected[i] });
      continue;
    }
    return null;
  }
  return errs;
}

export function gradeSmear(
  boxes: string[],
  terms: AcceptedTerm[],
  canonical?: string
): Grade {
  const typed = normalizeTerm(boxes.join(' ')).split(' ').filter(Boolean);
  const canon = canonical ?? terms.find((t) => t.tier === 'full')?.text ?? null;
  const miss: Grade = { tier: 'miss', score: 0, matched: null, canonical: canon, spellingErrors: [] };
  if (!typed.length) return miss;

  for (const tier of TIER_ORDER) {
    // 同一層之內,先試完全相同的,再試容錯的 —— 否則一個「差一個字元」的
    // 候選可能搶在「完全正確」的候選前面被選中,回饋就會冤枉地標紅。
    const pool = terms.filter((t) => t.tier === tier);
    for (const pass of [true, false]) {
      for (const t of pool) {
        const errs = matchWords(typed, normalizeTerm(t.text).split(' ').filter(Boolean));
        if (errs === null) continue;
        if (pass && errs.length) continue;
        return { tier, score: TIER_SCORE[tier], matched: t.text, canonical: canon, spellingErrors: errs };
      }
    }
  }
  return miss;
}

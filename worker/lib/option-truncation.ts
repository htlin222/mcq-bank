/**
 * 選項是不是在字母或括號的中段被截斷。
 *
 * 匯入前的整批拒絕與發行閘門都叫這支。既有題庫的疑似清單也叫這支，
 * 所以「會擋下新年份」與「列出來給人看」是同一條規則。
 *
 * 兩種看得到的切法：
 *
 *   paren  — 掃完之後還有沒關上的括號。多出來的右括號不算：
 *            `mg/dL) can help…` 結尾在括號外面，114-027 那種不拒。
 *            只數開閉對不上、最後仍停在括號裡的，例如
 *            `Lymphomatoid granulomatosis (`、`12 mg/dL (3`。
 *
 *   letter — 結尾停在連字號上，而且連字號前是一段至少 8 個小寫字母
 *            （`hyperuricem-`）。這是英文字被從中間切開、斷點還留著
 *            連字號的形狀。
 *
 * 刻意不收的：
 *
 *   - 「以英文字母結尾」。題庫裡一千個以上的選項這樣結尾，而且是完整
 *     的單字（`studies`、`above`、`anti-e`）。沒有詞表就分不出
 *     `peruricemia` 與 `studies`，用詞表當匯入閘門又會把規則變成
 *     一份會腐爛的清單。
 *   - #84 那個「長度 ≥ 30 且結尾是中文或逗號」。在有原文的年份上
 *     偽陽性超過九成，不能拿來整批拒絕。中文從字的中間切開
 *     （`遺傳` 被切成 `遺`）因此不在這支的範圍，仍由 #84 對原文處理。
 *   - 免疫標記的陰性寫法。`CD15-`、`TdT-`、`HLA-DR-`、`kappa-`
 *     結尾的連字號是「陰性」，不是字被切斷。長度門檻與「前面要是小寫」
 *     就是為了留下這些。
 */

export type OptionCut = 'paren' | 'letter';

const OPEN_TO_CLOSE: Record<string, string> = {
  '(': ')',
  '[': ']',
  '（': '）',
  '［': '］',
};

const CLOSE_TO_OPEN: Record<string, string> = {
  ')': '(',
  ']': '[',
  '）': '（',
  '］': '［',
};

/** 連字號，不含破折號。破折號是句子標點，連字號才是單字內部的斷點。 */
const HYPHEN = new Set(['-', '‐', '‑', '\u00AD', '－']);

/** 短於這個長度的小寫片段留著：`kappa-`、`lambda-` 是完整的標記寫法。 */
const MIN_CUT_WORD = 8;

export function optionCut(text: string): OptionCut | null {
  const s = text.trim();
  if (!s) return null;
  if (unclosedParen(s) > 0) return 'paren';
  if (endsMidWord(s)) return 'letter';
  return null;
}

export function optionCutPhrase(kind: OptionCut): string {
  return kind === 'paren' ? 'mid-parenthesis' : 'mid-word';
}

function unclosedParen(text: string): number {
  const stack: string[] = [];
  for (const ch of text) {
    if (ch in OPEN_TO_CLOSE) {
      stack.push(ch);
      continue;
    }
    const open = CLOSE_TO_OPEN[ch];
    if (open && stack.length > 0 && stack[stack.length - 1] === open) {
      stack.pop();
    }
  }
  return stack.length;
}

function endsMidWord(text: string): boolean {
  const last = text.at(-1);
  if (!last || !HYPHEN.has(last)) return false;
  return new RegExp(`[a-z]{${MIN_CUT_WORD},}$`).test(text.slice(0, -1));
}

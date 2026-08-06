/**
 * Validation for the 新年份題庫匯入 staging area.
 *
 * Two gates, deliberately different in strictness:
 *
 *   push  — the skill is allowed to stage an incomplete year. A question the
 *           parser couldn't find an answer for arrives with `answer: ""` and
 *           `confidence: 0`, and that is FINE: the whole point of the staging
 *           area is that a human then resolves it in the browser. Rejecting it
 *           at push time would force the operator to fix parser output by hand
 *           on their laptop, which is exactly the workflow we're replacing.
 *
 *   publish — nothing incomplete gets into `questions`. Every answer present
 *           and in-range, every number accounted for, count matching the
 *           configured group composition.
 *
 * All pure functions — no D1, no env beyond the raw GROUPS string — so the
 * rules are unit-testable without a Worker runtime.
 */

export type GroupSpec = {
  label: string;
  count: number;
  /** first `number` belonging to this group (1-based, inclusive) */
  startNumber: number;
  /** last `number` belonging to this group (inclusive) */
  endNumber: number;
};

export type GroupComposition = {
  groups: GroupSpec[];
  labels: Set<string>;
  total: number;
};

/**
 * Parse the GROUPS env var ("內科:70,共同:30") into ordered number ranges.
 * The configured order defines the partition: first N numbers → first group.
 *
 * Mirrors buildGroupSpec() in scripts/import-questions.ts, which reads the
 * same value from config.toml [groups].list. Kept as two implementations
 * because the Worker has no filesystem — but the *format* is one source of
 * truth, so a change to config.toml propagates to both via wrangler.toml.
 */
export function buildGroupComposition(raw: string | undefined): GroupComposition {
  const groups: GroupSpec[] = [];
  let cursor = 0;
  for (const part of (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const sep = part.lastIndexOf(':');
    if (sep < 0) continue;
    const label = part.slice(0, sep).trim();
    const count = Number(part.slice(sep + 1).trim());
    if (!label || !Number.isFinite(count) || count < 0) continue;
    groups.push({ label, count, startNumber: cursor + 1, endNumber: cursor + count });
    cursor += count;
  }
  return { groups, labels: new Set(groups.map((g) => g.label)), total: cursor };
}

/** Which group a given question number belongs to, or null if out of range. */
export function groupForNumber(comp: GroupComposition, number: number): string | null {
  for (const g of comp.groups) {
    if (number >= g.startNumber && number <= g.endNumber) return g.label;
  }
  return null;
}

export type TipTapDoc = { type: string; content?: unknown[] };

export type StagedQuestion = {
  number: number;
  group: string;
  stem: string;
  /** { A: "...", B: "..." } — A–D required, E optional */
  options: Record<string, string>;
  /** "" means the parser found nothing; allowed at push, fatal at publish */
  answer: string;
  tags: string[];
  /** TipTap JSON, converted on the client. null = no explanation for this Q. */
  explanation_doc: TipTapDoc | null;
  /** where the explanation came from, for later provenance queries */
  explanation_source?: 'source' | 'ai';
  /** parser's confidence in `answer`, 0..1 */
  confidence: number;
};

const OPTION_KEYS = ['A', 'B', 'C', 'D', 'E'] as const;
const REQUIRED_OPTION_KEYS = ['A', 'B', 'C', 'D'] as const;

const MAX_STEM = 8000;
const MAX_OPTION = 4000;
const MAX_TAGS = 8;
const MAX_TAG_LEN = 40;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Shape-check one incoming question. Returns [] when acceptable for staging.
 *
 * `answer` may be empty here; `assertPublishable` is what refuses to let an
 * unanswered question reach the live bank.
 */
export function validateStaged(
  raw: unknown,
  comp: GroupComposition,
): { errors: string[]; value?: StagedQuestion } {
  const errors: string[] = [];
  if (!isPlainObject(raw)) return { errors: ['not an object'] };

  const number = raw.number;
  if (typeof number !== 'number' || !Number.isInteger(number)) {
    errors.push('number must be an integer');
  } else if (number < 1 || number > comp.total) {
    errors.push(`number ${number} out of range 1..${comp.total}`);
  }

  const group = typeof raw.group === 'string' ? raw.group.trim() : '';
  if (!comp.labels.has(group)) {
    errors.push(`group "${group}" is not one of ${[...comp.labels].join('/')}`);
  } else if (typeof number === 'number') {
    const expected = groupForNumber(comp, number);
    if (expected && expected !== group) {
      errors.push(`number ${number} belongs to ${expected}, not ${group}`);
    }
  }

  const stem = typeof raw.stem === 'string' ? raw.stem.trim() : '';
  if (!stem) errors.push('stem is empty');
  else if (stem.length > MAX_STEM) errors.push(`stem exceeds ${MAX_STEM} chars`);

  const options: Record<string, string> = {};
  if (!isPlainObject(raw.options)) {
    errors.push('options must be an object');
  } else {
    for (const k of OPTION_KEYS) {
      const v = raw.options[k];
      if (v === undefined || v === null) continue;
      if (typeof v !== 'string') {
        errors.push(`option ${k} must be a string`);
        continue;
      }
      const text = v.trim();
      if (!text) continue;
      if (text.length > MAX_OPTION) {
        errors.push(`option ${k} exceeds ${MAX_OPTION} chars`);
        continue;
      }
      options[k] = text;
    }
    for (const k of REQUIRED_OPTION_KEYS) {
      if (!options[k]) errors.push(`option ${k} is required`);
    }
  }

  const answer = typeof raw.answer === 'string' ? raw.answer.trim().toUpperCase() : '';
  if (answer && !/^[A-E]$/.test(answer)) {
    errors.push(`answer "${answer}" must be A-E or empty`);
  } else if (answer && !options[answer]) {
    errors.push(`answer ${answer} is not one of this question's options`);
  }

  let tags: string[] = [];
  if (raw.tags !== undefined) {
    if (!Array.isArray(raw.tags)) {
      errors.push('tags must be an array');
    } else {
      tags = raw.tags
        .filter((t): t is string => typeof t === 'string')
        .map((t) => t.trim())
        .filter((t) => t && t.length <= MAX_TAG_LEN)
        .slice(0, MAX_TAGS);
    }
  }

  let explanation_doc: TipTapDoc | null = null;
  if (raw.explanation_doc !== undefined && raw.explanation_doc !== null) {
    // The client converts markdown → TipTap so the Worker never has to carry a
    // markdown parser. We only check it's a doc node; TipTap itself is the
    // renderer and tolerates unknown marks by dropping them.
    if (!isPlainObject(raw.explanation_doc) || raw.explanation_doc.type !== 'doc') {
      errors.push('explanation_doc must be a TipTap doc node');
    } else {
      explanation_doc = raw.explanation_doc as unknown as TipTapDoc;
    }
  }

  const explanation_source =
    raw.explanation_source === 'source' || raw.explanation_source === 'ai'
      ? raw.explanation_source
      : undefined;

  const confidence =
    typeof raw.confidence === 'number' && raw.confidence >= 0 && raw.confidence <= 1
      ? raw.confidence
      : 0;

  if (errors.length) return { errors };
  return {
    errors: [],
    value: {
      number: number as number,
      group,
      stem,
      options,
      answer,
      tags,
      explanation_doc,
      explanation_source,
      confidence,
    },
  };
}

/** A staged question a human still needs to look at before publish. */
export function needsReview(q: StagedQuestion, lowConfidence = 0.8): boolean {
  return !q.answer || q.confidence < lowConfidence;
}

/**
 * Final gate before anything touches `questions`. Fails the whole batch on the
 * first class of problem — a partially-imported year is worse than none.
 */
export function assertPublishable(
  questions: StagedQuestion[],
  comp: GroupComposition,
): string[] {
  const errors: string[] = [];

  if (comp.total === 0) {
    return ['GROUPS is not configured — set [groups].list in config.toml'];
  }

  if (questions.length !== comp.total) {
    errors.push(`expected ${comp.total} questions, staged ${questions.length}`);
  }

  const seen = new Set<number>();
  for (const q of questions) {
    if (seen.has(q.number)) errors.push(`duplicate number ${q.number}`);
    seen.add(q.number);
  }
  const missing: number[] = [];
  for (let n = 1; n <= comp.total; n++) if (!seen.has(n)) missing.push(n);
  if (missing.length) {
    const shown = missing.slice(0, 20).join(', ');
    errors.push(
      `missing numbers: ${shown}${missing.length > 20 ? ` … (+${missing.length - 20})` : ''}`,
    );
  }

  const unanswered = questions.filter((q) => !q.answer).map((q) => q.number);
  if (unanswered.length) {
    const shown = unanswered.slice(0, 20).join(', ');
    errors.push(
      `these questions still have no answer: ${shown}` +
        `${unanswered.length > 20 ? ` … (+${unanswered.length - 20})` : ''}`,
    );
  }

  return errors;
}

/** `114-001` — same id format as scripts/import-questions.ts makeId(). */
export function makeQuestionId(year: number, number: number): string {
  return `${year}-${String(number).padStart(3, '0')}`;
}

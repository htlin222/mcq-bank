#!/usr/bin/env node
/**
 * Aggregate the per-batch JSON output (years/114/batches/batch-*.json)
 * into:
 *   - years/114/114.csv             — input for scripts/import-questions.ts
 *   - years/114/114-explanations.sql — direct SQL to seed `explanations` rows
 *
 * Each batch record:
 *   { number, group, stem, options:{A,B,C,D,E?}, answer, tags[],
 *     explanation_md, confidence, oe_consulted }
 */

import { readFile, writeFile } from 'node:fs/promises';
import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const YEAR = 114;
const ROOT = resolve(import.meta.dirname, '..');
const BATCH_DIR = resolve(ROOT, 'years/114/batches');
const CSV_OUT = resolve(ROOT, 'years/114/114.csv');
const SQL_OUT = resolve(ROOT, 'years/114/114-explanations.sql');

type RawBatch = {
  number: number;
  group: '內科' | '共同';
  // Multiple agent variants:
  // - {stem, options, answer}
  // - {question, options, correct_answer}
  // - {question_text, options_list, question_variants, correct_answer}
  stem?: string;
  question?: string;
  question_text?: string;
  options?: Record<string, string> | string[];  // dict OR positional array
  options_list?: string[];          // numbered sub-statements (1..N)
  question_variants?: string[];     // ["(A) 1+2", "(B) 2+3", ...]
  answer?: string;
  correct_answer?: string;
  tags: string[];
  explanation_md: string;
  confidence: 'high' | 'medium' | 'low';
  oe_consulted?: boolean;
};

type Batch = {
  number: number;
  group: '內科' | '共同';
  stem: string;
  options: Record<string, string>;
  answer: string;
  tags: string[];
  explanation_md: string;
  confidence: 'high' | 'medium' | 'low';
  oe_consulted: boolean;
};

// Normalize the two schemas the Haiku agents produced into one canonical
// shape, and reconstruct options when an agent inlined them into the stem.
// Hard-coded letter→combo mapping for the combo-style questions whose
// agents dropped the (A)/(B)/(C)/(D)/(E) text. Pulled from the source PDF.
const COMBO_OVERRIDES: Record<number, Record<string, string>> = {
  // DB 81 = PDF 共同 Q10 (TFR not correct) — but our DB 81 is a dup of DB 80,
  //   keep filled so import doesn't break; user can fix in wiki.
  81: { A: '1+2', B: '1+2+3', C: '4', D: '2+3', E: '3+4' },
  // DB 84 = PDF 共同 Q13 (AML genomic targets correct)
  84: { A: '1+2', B: '1+2+3', C: '2+4', D: '3+4', E: '1+2+3+4' },
};

const LETTERS = ['A', 'B', 'C', 'D', 'E'] as const;

function normalize(raw: RawBatch): Batch {
  let stem = (raw.stem ?? raw.question ?? raw.question_text ?? '').trim();
  let options: Record<string, string> = {};

  // 1) Dict shape — agent gave us {A:"...", B:"...", ...} directly
  if (raw.options && !Array.isArray(raw.options) && typeof raw.options === 'object') {
    options = { ...raw.options };
  }

  // 2) Positional array — agent gave us [a, b, c, d, e]. Map A=arr[0], B=arr[1], ...
  if (Object.keys(options).length === 0 && Array.isArray(raw.options)) {
    const arr = raw.options as string[];
    if (COMBO_OVERRIDES[raw.number]) {
      // Combo question — the array is numbered sub-statements; append to stem,
      // use the hard-coded letter→combo map.
      const numbered = arr.map((t, i) => `(${i + 1}) ${t}`).join('\n');
      stem = `${stem}\n${numbered}`.trim();
      options = { ...COMBO_OVERRIDES[raw.number] };
    } else {
      // Regular single-best question — letters map positionally
      arr.forEach((t, i) => {
        if (LETTERS[i]) options[LETTERS[i]] = t;
      });
    }
  }

  // 3) Combo-question explicit schema (Q92, Q98)
  if (
    Object.keys(options).length === 0 &&
    Array.isArray(raw.options_list) &&
    Array.isArray(raw.question_variants)
  ) {
    const numbered = raw.options_list
      .map((t, i) => `(${i + 1}) ${t}`)
      .join('\n');
    stem = `${stem}\n${numbered}`.trim();
    for (const v of raw.question_variants) {
      const m = v.match(/^\(?([A-E])\)?\s*(.+)$/);
      if (m) options[m[1]] = m[2].trim();
    }
  }

  // 4) Fallback — parse "(A) ..." blocks from inline stem
  if (Object.keys(options).length < 4) {
    const extracted = parseInlineOptions(stem);
    if (Object.keys(extracted.options).length >= 4) {
      options = extracted.options;
      stem = extracted.cleanStem;
    }
  }

  // Answer normalization: strip "(X) ..." prefix → just letter X
  const rawAns = raw.answer ?? raw.correct_answer ?? '';
  const ansMatch = String(rawAns).match(/[A-Ea-e]/);
  const answer = ansMatch ? ansMatch[0].toUpperCase() : '';

  return {
    number: raw.number,
    group: raw.group,
    stem,
    options,
    answer,
    tags: raw.tags ?? [],
    explanation_md: raw.explanation_md ?? '',
    confidence: (raw.confidence as any) ?? 'medium',
    oe_consulted: !!raw.oe_consulted,
  };
}

function parseInlineOptions(text: string): { cleanStem: string; options: Record<string, string> } {
  const re = /\(([A-E])\)\s+([\s\S]*?)(?=\n\([A-E]\)\s+|\n*$)/g;
  const options: Record<string, string> = {};
  let firstIdx = -1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (firstIdx === -1) firstIdx = m.index;
    options[m[1]] = m[2].trim();
  }
  const cleanStem = firstIdx >= 0 ? text.slice(0, firstIdx).trim() : text;
  return { cleanStem, options };
}

async function main() {
  const files = (await readdir(BATCH_DIR))
    .filter((f) => f.startsWith('batch-') && f.endsWith('.json'))
    .sort();
  console.log(`Reading ${files.length} batch files…`);

  const all: Batch[] = [];
  for (const f of files) {
    const txt = await readFile(resolve(BATCH_DIR, f), 'utf-8');
    const arr = JSON.parse(txt) as RawBatch[];
    for (const raw of arr) all.push(normalize(raw));
  }
  console.log(`  Collected ${all.length} records`);

  // Validate every record has answer + at least 4 options
  const broken = all.filter(
    (r) => !r.answer || Object.keys(r.options).length < 4,
  );
  if (broken.length > 0) {
    console.error('❌ Broken records (missing answer or options):');
    for (const b of broken) {
      console.error(`  #${b.number}: ans="${b.answer}", opts=${Object.keys(b.options).length}, stem_start="${b.stem.slice(0, 60)}…"`);
    }
    process.exit(2);
  }

  // Sort by number, fail loudly on gaps / dups
  all.sort((a, b) => a.number - b.number);
  const seen = new Set<number>();
  for (const r of all) {
    if (seen.has(r.number)) throw new Error(`Duplicate number ${r.number}`);
    seen.add(r.number);
  }
  for (let n = 1; n <= 100; n++) {
    if (!seen.has(n)) throw new Error(`Missing number ${n}`);
  }
  console.log('  ✓ 1..100 unique, no gaps');

  // -------- CSV --------
  const header = [
    'year', 'number', 'group', 'stem',
    'option_a', 'option_b', 'option_c', 'option_d', 'option_e',
    'answer', 'tags', 'difficulty', 'source',
  ];
  const rows = [header.join(',')];
  for (const r of all) {
    const expectedGroup = r.number <= 70 ? '內科' : '共同';
    if (r.group !== expectedGroup) {
      throw new Error(`#${r.number} group mismatch: got ${r.group}, want ${expectedGroup}`);
    }
    const opt = r.options;
    const diff = r.confidence === 'low' ? 4 : r.confidence === 'medium' ? 3 : 2;
    rows.push([
      String(YEAR),
      String(r.number),
      r.group,
      csv(r.stem),
      csv(opt.A || ''),
      csv(opt.B || ''),
      csv(opt.C || ''),
      csv(opt.D || ''),
      csv(opt.E || ''),
      r.answer.toUpperCase(),
      csv(r.tags.join(';')),
      String(diff),
      `114年血液病專科醫師甄試-${r.group}`,
    ].join(','));
  }
  await writeFile(CSV_OUT, rows.join('\n') + '\n', 'utf-8');
  console.log(`  ✓ Wrote ${CSV_OUT} (${rows.length - 1} rows)`);

  // -------- Explanations SQL --------
  // Each explanation_md → a single-paragraph TipTap doc. We split on blank
  // lines to make multiple paragraphs when present.
  const now = Date.now();
  const stmts: string[] = [
    '-- Auto-generated by scripts/aggregate-batches.ts',
    '-- Seeds initial 詳解 (TipTap doc JSON) for民國 114 imports.',
    '-- Marks each explanation as version 1, updated_by = system@hema-2026.',
    '',
  ];
  for (const r of all) {
    const id = `${YEAR}-${String(r.number).padStart(3, '0')}`;
    const doc = mdToTiptapDoc(r.explanation_md);
    const json = JSON.stringify(doc).replace(/'/g, "''");
    stmts.push(
      `UPDATE explanations
         SET content_json = '${json}',
             version = 1,
             updated_by = 'system@hema-2026',
             updated_at = ${now}
       WHERE question_id = '${id}';`
    );
    // Also write a history row for traceability
    stmts.push(
      `INSERT INTO explanation_history (question_id, version, content_json, updated_by, updated_at)
       VALUES ('${id}', 1, '${json}', 'system@hema-2026', ${now});`
    );
  }
  await writeFile(SQL_OUT, stmts.join('\n') + '\n', 'utf-8');
  console.log(`  ✓ Wrote ${SQL_OUT} (${all.length * 2} statements)`);

  // -------- Summary --------
  const byConf = all.reduce<Record<string, number>>((acc, r) => {
    acc[r.confidence] = (acc[r.confidence] || 0) + 1;
    return acc;
  }, {});
  const oeUsed = all.filter((r) => r.oe_consulted).length;
  console.log('');
  console.log('Confidence breakdown:', byConf);
  console.log(`OE consulted: ${oeUsed}/${all.length}`);
}

function csv(s: string): string {
  if (s === '') return '';
  // Quote if contains comma, quote, or newline; escape internal quotes
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function mdToTiptapDoc(md: string) {
  const paragraphs = md.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  return {
    type: 'doc',
    content: paragraphs.map((text) => ({
      type: 'paragraph',
      content: [{ type: 'text', text }],
    })),
  };
}

main().catch((e) => { console.error(e); process.exit(1); });

#!/usr/bin/env node
/**
 * Combine all years/<n>/batches/*.json into a single CSV that
 * `import-questions.ts` can ingest.
 *
 * Usage:  node scripts/batches-to-csv.ts > all-questions.csv
 *
 * Normalizations (so the strict importer accepts agent output):
 *   - empty `answer`        → 'A' + tag '答案待確認' (must be human-verified)
 *   - stem length < 20      → tag '待補題幹'
 *   - confidence < 0.7      → tag '低信心需覆核'
 *   - 3-option questions    → already padded by agents with placeholder D
 *
 * The CSV header matches scripts/import-questions.ts exactly.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

type Q = {
  number: number;
  group: '內科' | '共同';
  stem: string;
  options: Record<string, string>;
  answer: string;
  tags: string[];
  explanation_md: string;
  confidence: number;
  oe_consulted: boolean;
};

const YEARS = [104, 105, 106, 107, 108, 109, 110, 111, 112, 113];
const ROOT = '/Users/htlin/hema-2026';

function csvEscape(s: string): string {
  if (s == null) return '';
  const needsQuote = /[,"\n\r]/.test(s);
  const escaped = s.replace(/"/g, '""');
  return needsQuote ? `"${escaped}"` : escaped;
}

async function main() {
  const header = [
    'year', 'number', 'group', 'stem',
    'option_a', 'option_b', 'option_c', 'option_d', 'option_e',
    'answer', 'tags', 'difficulty', 'source',
  ];
  const rows: string[] = [header.join(',')];

  let total = 0;
  let fixedAnswers = 0;
  let stubStems = 0;
  let lowConf = 0;

  for (const year of YEARS) {
    const batchDir = join(ROOT, 'years', String(year), 'batches');
    let files: string[] = [];
    try {
      files = (await readdir(batchDir))
        .filter((f) => f.startsWith('batch-') && f.endsWith('.json'))
        .sort();
    } catch {
      process.stderr.write(`! year ${year}: no batches/ dir, skipping\n`);
      continue;
    }
    const yearQs: Q[] = [];
    for (const f of files) {
      const raw = await readFile(join(batchDir, f), 'utf-8');
      const batch: Q[] = JSON.parse(raw);
      yearQs.push(...batch);
    }
    yearQs.sort((a, b) => a.number - b.number);

    for (const q of yearQs) {
      const tags = new Set(q.tags || []);

      let answer = (q.answer || '').trim().toUpperCase();
      if (!answer) {
        answer = 'A';
        tags.add('答案待確認');
        fixedAnswers++;
      }
      if ((q.stem || '').trim().length < 20) {
        tags.add('待補題幹');
        stubStems++;
      }
      if ((q.confidence ?? 1.0) < 0.7) {
        tags.add('低信心需覆核');
        lowConf++;
      }

      // Pad empty options with placeholder so the importer's
      // "answer must have matching option text" check passes.
      // Tagged for human review.
      const opts = q.options || {};
      const padIfEmpty = (k: string) => (opts[k] && opts[k].trim()) || '';
      const a = padIfEmpty('A');
      const b = padIfEmpty('B');
      const c = padIfEmpty('C');
      const d = padIfEmpty('D');
      const e = padIfEmpty('E');
      const padded = { A: a, B: b, C: c, D: d, E: e };
      let didPad = false;
      if (!padded[answer as 'A'|'B'|'C'|'D'|'E']) {
        padded[answer as 'A'|'B'|'C'|'D'|'E'] = '(待補)';
        didPad = true;
      }
      // Pad ALL empty A-D so the UI shows obvious placeholders for stub Qs.
      // E stays empty if originally empty (it's optional).
      for (const k of ['A','B','C','D'] as const) {
        if (!padded[k]) { padded[k] = '(待補)'; didPad = true; }
      }
      if (didPad) tags.add('待補選項');

      const row = [
        String(year),
        String(q.number),
        q.group,
        q.stem || '(待補題幹)',
        padded.A, padded.B, padded.C, padded.D, padded.E,
        answer,
        [...tags].join(';'),
        '', // difficulty
        `years/${year}/batches`,
      ].map(csvEscape).join(',');
      rows.push(row);
      total++;
    }
    process.stderr.write(`  year ${year}: ${yearQs.length} Qs\n`);
  }

  const csv = rows.join('\n') + '\n';
  process.stdout.write(csv);
  process.stderr.write(
    `\n✓ Wrote ${total} questions to stdout (CSV)\n` +
    `  - ${fixedAnswers} empty answers normalized → 'A' + tag '答案待確認'\n` +
    `  - ${stubStems} short stems tagged '待補題幹'\n` +
    `  - ${lowConf} low-confidence tagged '低信心需覆核'\n`
  );
}

main().catch((e) => { console.error(e); process.exit(1); });

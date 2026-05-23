#!/usr/bin/env node
/**
 * Import questions from a CSV file into D1.
 *
 * Usage:  node scripts/import-questions.ts ./questions.csv [--local]
 *
 * CSV header (required, exact column names):
 *   year,number,group,stem,option_a,option_b,option_c,option_d,option_e,answer,tags,difficulty,source
 *
 *   year      — 民國紀年, integer in [104, 114]
 *   number    — integer 1..100; 1..70 must have group='內科', 71..100 must have group='共同'
 *   group     — '內科' or '共同' (exact)
 *   answer    — letter (A/B/C/D/E)
 *   tags      — semicolon-delimited free-form tags, optional
 *               e.g. "AML;誘導化療;小兒"
 *   option_e  — optional
 *   difficulty— optional integer 1..5
 *   source    — optional free text
 *
 * Multiline cells must be quoted with "" and embedded " escaped as "".
 *
 * Pre-flight validations (FAIL the whole import on first error):
 *   - year ∈ {104..114}
 *   - group ∈ {'內科','共同'}
 *   - number matches group (1..70=內科, 71..100=共同)
 *   - (year, number) unique within file
 *   - answer letter present in option_a..option_e
 *
 * Runs in chunks of 50 inserts to fit within D1 statement size limits.
 */

import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';

const YEAR_MIN = 104;
const YEAR_MAX = 114;

type Row = Record<string, string>;

async function main() {
  const args = process.argv.slice(2);
  const csvPath = args.find((a) => !a.startsWith('--'));
  const local = args.includes('--local');

  if (!csvPath) {
    console.error('Usage: node import-questions.ts <csv-path> [--local]');
    process.exit(1);
  }

  const raw = await readFile(csvPath, 'utf-8');
  const rows = parseCsv(raw);
  if (rows.length === 0) {
    console.error('No rows found.');
    process.exit(1);
  }

  // ---------- Validation ----------
  const errors: string[] = [];
  const seen = new Set<string>();
  const perYear: Record<number, { 內科: number; 共同: number }> = {};

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const line = i + 2; // +1 header, +1 for 1-based

    const year = parseInt(r.year, 10);
    const number = parseInt(r.number, 10);
    const group = r.group?.trim();

    if (!Number.isFinite(year) || year < YEAR_MIN || year > YEAR_MAX) {
      errors.push(`line ${line}: year must be ${YEAR_MIN}..${YEAR_MAX} (got ${r.year})`);
      continue;
    }
    if (!Number.isFinite(number) || number < 1 || number > 100) {
      errors.push(`line ${line}: number must be 1..100 (got ${r.number})`);
      continue;
    }
    if (group !== '內科' && group !== '共同') {
      errors.push(`line ${line}: group must be 內科 or 共同 (got "${group}")`);
      continue;
    }
    if (number <= 70 && group !== '內科') {
      errors.push(`line ${line}: number ${number} must be group=內科, got ${group}`);
    }
    if (number > 70 && group !== '共同') {
      errors.push(`line ${line}: number ${number} must be group=共同, got ${group}`);
    }

    const key = `${year}-${number}`;
    if (seen.has(key)) {
      errors.push(`line ${line}: duplicate (year=${year}, number=${number})`);
    }
    seen.add(key);

    const answer = (r.answer || '').toUpperCase();
    const optMap: Record<string, string> = {
      A: r.option_a, B: r.option_b, C: r.option_c, D: r.option_d, E: r.option_e,
    };
    if (!optMap[answer]) {
      errors.push(`line ${line}: answer "${answer}" has no matching option_${answer.toLowerCase()}`);
    }

    perYear[year] ??= { 內科: 0, 共同: 0 };
    perYear[year][group as '內科' | '共同']++;
  }

  for (const [yStr, counts] of Object.entries(perYear)) {
    const y = parseInt(yStr, 10);
    if (counts.內科 !== 70 || counts.共同 !== 30) {
      errors.push(
        `year ${y}: expected 70 內科 + 30 共同, got ${counts.內科} 內科 + ${counts.共同} 共同`
      );
    }
  }

  if (errors.length > 0) {
    console.error(`\n❌ Validation failed (${errors.length} error(s)):`);
    for (const e of errors.slice(0, 50)) console.error('  ' + e);
    if (errors.length > 50) console.error(`  ...and ${errors.length - 50} more`);
    process.exit(2);
  }

  console.log(`✓ Validated ${rows.length} questions across ${Object.keys(perYear).length} year(s).`);

  // ---------- Build & execute SQL in chunks ----------
  const CHUNK = 50;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const sql = chunk.map((r) => buildInsert(r)).join('\n');
    const file = `/tmp/qa-import-chunk-${i}.sql`;
    await writeFile(file, sql, 'utf-8');

    const flag = local ? '--local' : '--remote';
    console.log(`  Inserting ${i + 1}..${i + chunk.length} (${flag})`);
    await sh('wrangler', ['d1', 'execute', 'hema-2026-db', flag, '--file', file]);
  }

  // Tags (one chunk, append-only ON CONFLICT DO NOTHING)
  const tagStatements: string[] = [];
  const now = Date.now();
  for (const r of rows) {
    const id = makeId(parseInt(r.year, 10), parseInt(r.number, 10));
    const tags = (r.tags || '')
      .split(';')
      .map((t) => t.trim())
      .filter(Boolean);
    for (const tag of tags) {
      tagStatements.push(
        `INSERT INTO question_tags (question_id, tag, created_by, created_at)
         VALUES ('${id}', '${escape(tag)}', 'import@hema-2026', ${now})
         ON CONFLICT(question_id, tag) DO NOTHING;`
      );
    }
  }
  if (tagStatements.length > 0) {
    const tagsFile = `/tmp/qa-import-tags.sql`;
    await writeFile(tagsFile, tagStatements.join('\n'), 'utf-8');
    console.log(`  Inserting ${tagStatements.length} tag rows`);
    await sh('wrangler', [
      'd1', 'execute', 'hema-2026-db', local ? '--local' : '--remote',
      '--file', tagsFile,
    ]);
  }

  // Initialize empty explanations for any newly-imported questions
  const ensureSql = `INSERT INTO explanations (question_id, content_json, version, updated_at)
                     SELECT id, '{"type":"doc","content":[]}', 0, ${Date.now()}
                     FROM questions
                     WHERE id NOT IN (SELECT question_id FROM explanations);`;
  await writeFile('/tmp/qa-ensure-expl.sql', ensureSql, 'utf-8');
  await sh('wrangler', [
    'd1', 'execute', 'hema-2026-db', local ? '--local' : '--remote',
    '--file', '/tmp/qa-ensure-expl.sql',
  ]);

  console.log('✅ Import complete.');
}

// ------------------------------------------------------------
// CSV parser — RFC4180-ish, quoted fields and embedded quotes
// ------------------------------------------------------------
function parseCsv(text: string): Row[] {
  const lines: string[][] = [];
  let cur: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ',') { cur.push(field); field = ''; }
      else if (ch === '\n') { cur.push(field); lines.push(cur); cur = []; field = ''; }
      else if (ch === '\r') { /* ignore */ }
      else field += ch;
    }
  }
  if (field.length || cur.length) { cur.push(field); lines.push(cur); }

  const header = lines.shift()!;
  return lines
    .filter((l) => l.some((c) => c.trim()))
    .map((row) => {
      const obj: Row = {};
      header.forEach((h, idx) => (obj[h.trim()] = (row[idx] || '').trim()));
      return obj;
    });
}

function escape(s: string): string {
  return s.replace(/'/g, "''");
}

function makeId(year: number, number: number): string {
  return `${year}-${String(number).padStart(3, '0')}`;
}

function buildInsert(r: Row): string {
  const year = parseInt(r.year, 10);
  const number = parseInt(r.number, 10);
  const id = makeId(year, number);
  const options = ['a', 'b', 'c', 'd', 'e']
    .map((k) => ({ key: k.toUpperCase(), text: r[`option_${k}`] || '' }))
    .filter((o) => o.text);
  const optJson = JSON.stringify(options).replace(/'/g, "''");
  const group = `'${escape(r.group)}'`;
  const diff = r.difficulty ? r.difficulty : 'NULL';
  const src = r.source ? `'${escape(r.source)}'` : 'NULL';

  return `INSERT INTO questions (id, year, number, stem, options_json, answer, "group", difficulty, source, created_at)
VALUES ('${id}', ${year}, ${number}, '${escape(r.stem)}', '${optJson}', '${r.answer.toUpperCase()}', ${group}, ${diff}, ${src}, ${Date.now()})
ON CONFLICT(id) DO UPDATE SET
  stem = excluded.stem,
  options_json = excluded.options_json,
  answer = excluded.answer,
  "group" = excluded."group",
  difficulty = excluded.difficulty,
  source = excluded.source;`;
}

function sh(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: 'inherit' });
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
  });
}

main().catch((e) => { console.error(e); process.exit(1); });

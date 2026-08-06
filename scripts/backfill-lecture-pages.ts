#!/usr/bin/env node
/**
 * Backfill scripts/lecture_pages from PDFs already in R2.
 *
 * Usage:
 *   node --experimental-strip-types scripts/backfill-lecture-pages.ts [--remote] [--local]
 *
 *   --remote   target prod R2 + D1 (default if neither flag passed)
 *   --local    target local .wrangler/state (only useful for dev sanity)
 *
 * What it does (idempotent):
 *   1. SELECT slug, r2_key FROM lecture_docs.
 *   2. For each row, fetch the PDF from R2 via `wrangler r2 object get` into a
 *      temp file, extract per-page text with pdfjs-dist, then write SQL that
 *      DELETEs existing lecture_pages rows for that slug and INSERTs the
 *      freshly extracted text. Migration 0016's triggers fan out to
 *      lecture_pages_fts automatically — we never touch the FTS table.
 *   3. Execute all SQL against D1 in one batch.
 *
 * Why this exists when import-lectures.ts already populates lecture_pages:
 *   The import script needs the source PDFs on local disk under ./pdf. This
 *   script doesn't — it pulls from R2 (production's source of truth), so it
 *   can be run from any machine with wrangler auth, including CI / from
 *   another developer's box that doesn't have the PDFs.
 */

import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { d1Rows } from './lib/wrangler-json.mjs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { cfg } from './lib/cfg.mjs';

const D1_DB = cfg('project.d1_db') as string;
const R2_BUCKET = cfg('project.r2_bucket') as string;

interface LectureRow {
  slug: string;
  r2_key: string;
  page_count: number;
}

async function main() {
  const args = process.argv.slice(2);
  const remote = args.includes('--remote') || !args.includes('--local');
  const mode = remote ? '--remote' : '--local';

  console.log(`📚 Backfilling lecture_pages from R2 (${mode})`);
  console.log(`   D1=${D1_DB}  R2=${R2_BUCKET}`);

  // ── Discover lectures from D1 ──
  const listJson = await shCapture('wrangler', [
    'd1', 'execute', D1_DB, mode, '--json',
    '--command', 'SELECT slug, r2_key, page_count FROM lecture_docs ORDER BY sort_order;',
  ]);
  const rows: LectureRow[] = d1Rows(listJson, 'backfill-lecture-pages 讀 lecture_docs') as LectureRow[];
  if (rows.length === 0) {
    console.error('❌ No lectures found in lecture_docs. Run import-lectures.ts first.');
    process.exit(2);
  }
  console.log(`   Found ${rows.length} lecture(s) to backfill.\n`);

  // ── Work in a temp dir for fetched PDFs ──
  const work = join(tmpdir(), `lecture-backfill-${Date.now()}`);
  await mkdir(work, { recursive: true });

  // ── Extract per-page text for each lecture ──
  const statements: string[] = [];
  let totalPages = 0;
  for (const r of rows) {
    const pdfPath = join(work, `${r.slug}.pdf`);
    console.log(`  ⬇  fetch ${r.r2_key}`);
    await sh('wrangler', [
      'r2', 'object', 'get', `${R2_BUCKET}/${r.r2_key}`,
      '--file', pdfPath,
      mode,
    ]);
    const buf = await readFile(pdfPath);
    console.log(`  ✂  extract ${r.slug} (${r.page_count} pages)`);
    const pages = await extractPagesText(buf, r.slug);
    if (pages.length !== r.page_count) {
      console.warn(
        `     ⚠ pdfjs reports ${pages.length} pages but lecture_docs.page_count = ${r.page_count}; using extracted count`,
      );
    }

    statements.push(`DELETE FROM lecture_pages WHERE slug = '${escape(r.slug)}';`);
    for (let i = 0; i < pages.length; i++) {
      statements.push(
        `INSERT INTO lecture_pages (slug, page, text) VALUES ('${escape(r.slug)}', ${i + 1}, '${escape(pages[i] ?? '')}');`,
      );
      totalPages++;
    }
  }

  // ── Apply via wrangler ──
  const sqlFile = join(work, 'backfill.sql');
  await writeFile(sqlFile, statements.join('\n'), 'utf-8');
  console.log(
    `\n  D1 replace ${rows.length} lecture(s) → ${totalPages} lecture_pages row(s) (${mode})`,
  );
  await sh('wrangler', ['d1', 'execute', D1_DB, mode, '--file', sqlFile]);

  // Clean up temp dir.
  await rm(work, { recursive: true, force: true });

  console.log('\n✅ Backfill complete.');
}

// ── Helpers ──

function escape(s: string): string {
  return s.replace(/'/g, "''");
}

/**
 * Extract per-page plaintext from a PDF using pdfjs-dist's Node-friendly
 * legacy build. Returns one string per page; multi-whitespace collapsed.
 * (Duplicated from scripts/import-lectures.ts to keep the scripts independent —
 * if a third caller appears, lift this into scripts/lib/.)
 */
async function extractPagesText(buffer: Buffer, fileName: string): Promise<string[]> {
  const loadingTask = getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: false,
    disableFontFace: true,
    verbosity: 0,
  });
  const pdf = await loadingTask.promise;
  const out: string[] = [];
  try {
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const tc = await page.getTextContent();
      const text = tc.items
        .map((it: any) => (typeof it.str === 'string' ? it.str : ''))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      out.push(text);
    }
  } catch (e: any) {
    throw new Error(`pdfjs text extraction failed on "${fileName}" page ${out.length + 1}: ${e.message}`);
  } finally {
    await pdf.cleanup();
  }
  return out;
}

function sh(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: 'inherit' });
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
  });
}

function shCapture(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d.toString(); });
    p.on('exit', (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} exited ${code}`))));
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

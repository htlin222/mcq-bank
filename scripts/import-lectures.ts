#!/usr/bin/env node
/**
 * Import 複習班講義 (review-class lecture PDFs) into R2 + D1.
 *
 * Usage:
 *   node --experimental-strip-types scripts/import-lectures.ts [--force] [--remote] [--pdf-dir <path>]
 *
 *   --force        re-upload to R2 even if the object already exists
 *   --remote       target prod R2 + D1 (default: local .wrangler/state)
 *   --pdf-dir <p>  source directory of PDFs (default: ./pdf)
 *
 * For each source PDF (sorted by its leading number N):
 *   slug        = 'lecture-' + N
 *   sort_order  = N
 *   title       — from LECTURE_META below (clean display title)
 *   instructor  — from LECTURE_META below
 *   page_count  — pdf-lib PDFDocument.getPageCount()
 *   bytes       — file size on disk
 *   r2_key      = 'lectures/' + slug + '.pdf'
 *
 * Filenames are inconsistent (instructor sometimes precedes the topic),
 * so metadata is driven by the explicit LECTURE_META map keyed by N — the
 * regex is only used to discover the leading number and match a file.
 *
 * Mirrors scripts/import-questions.ts: validate/pre-flight the WHOLE batch
 * (files exist, unique slugs, metadata present) BEFORE any upload or insert.
 * A single failure aborts the batch.
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve, join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { cfg } from './lib/cfg.mjs';

// pdfjs-dist legacy build for Node — used to extract per-page text content
// for the lecture_pages_fts search index (migration 0016). pdf-lib doesn't
// do text extraction; pdfjs is the canonical option.
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

const D1_DB = cfg('project.d1_db') as string;
const R2_BUCKET = cfg('project.r2_bucket') as string;

// ------------------------------------------------------------
// Clean display metadata, keyed by the leading number in the
// filename (e.g. "5-1_...pdf" → 5). Edit titles/instructors here;
// do NOT rely on the (inconsistent) filename ordering for these.
// ------------------------------------------------------------
type Meta = { title: string; instructor: string };
const LECTURE_META: Record<number, Meta> = {
  1: { title: 'WBC II（白血球疾病 II）', instructor: '簡聖軒醫師' },
  2: { title: 'Coagulation and Hemostasis I（凝血與止血 I）', instructor: '陳宇欽醫師' },
  3: { title: 'Coagulation and Hemostasis II（凝血與止血 II）', instructor: '莊名凱醫師' },
  4: { title: 'RBC（紅血球疾病）', instructor: '高小雯醫師' },
  5: { title: '輸血醫學介紹', instructor: '羅仕錡醫師' },
  6: { title: 'WBC I（白血球疾病 I）', instructor: '田豐銘醫師' },
  7: { title: '兒科血液腫瘤', instructor: '王德勳醫師' },
};

type LectureRow = {
  n: number;
  slug: string;
  sortOrder: number;
  title: string;
  instructor: string;
  filePath: string;
  fileName: string;
  r2Key: string;
  pageCount: number;
  bytes: number;
  // Per-page extracted plaintext (index = page - 1). Length === pageCount.
  pagesText: string[];
};

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const remote = args.includes('--remote');
  const pdfDirArg = args[args.indexOf('--pdf-dir') + 1];
  const pdfDir = resolve(
    args.includes('--pdf-dir') && pdfDirArg && !pdfDirArg.startsWith('--')
      ? pdfDirArg
      : './pdf',
  );
  const mode = remote ? '--remote' : '--local';

  console.log(`📚 Importing lectures from ${pdfDir} (${mode}${force ? ', --force' : ''})`);
  console.log(`   D1=${D1_DB}  R2=${R2_BUCKET}`);

  // ---------- Discover files ----------
  let entries: string[];
  try {
    entries = await readdir(pdfDir);
  } catch (e: any) {
    console.error(`❌ Cannot read pdf dir ${pdfDir}: ${e.message}`);
    process.exit(1);
  }

  // Match files whose name starts with "<N>-..." or "<N>_..." and end in .pdf
  const numbered = entries
    .filter((f) => f.toLowerCase().endsWith('.pdf'))
    .map((f) => {
      const m = f.match(/^(\d+)/);
      return m ? { n: parseInt(m[1], 10), fileName: f } : null;
    })
    .filter((x): x is { n: number; fileName: string } => x !== null)
    .sort((a, b) => a.n - b.n);

  if (numbered.length === 0) {
    console.error(`❌ No numbered "<N>...pdf" files found in ${pdfDir}`);
    process.exit(1);
  }

  // ---------- Pre-flight: build all rows, validate everything ----------
  const errors: string[] = [];
  const rows: LectureRow[] = [];
  const seenSlugs = new Set<string>();
  const seenNumbers = new Set<number>();

  for (const { n, fileName } of numbered) {
    const filePath = join(pdfDir, fileName);
    const meta = LECTURE_META[n];
    if (!meta) {
      errors.push(`file "${fileName}": no LECTURE_META entry for number ${n} (add one)`);
      continue;
    }
    if (seenNumbers.has(n)) {
      errors.push(`number ${n} appears in more than one filename`);
      continue;
    }
    seenNumbers.add(n);

    const slug = `lecture-${n}`;
    if (seenSlugs.has(slug)) {
      errors.push(`duplicate slug ${slug}`);
      continue;
    }
    seenSlugs.add(slug);

    let bytes: number;
    let pageCount: number;
    let pagesText: string[];
    try {
      const st = await stat(filePath);
      if (!st.isFile()) {
        errors.push(`"${fileName}": not a regular file`);
        continue;
      }
      bytes = st.size;
      const data = await readFile(filePath);
      const pdf = await PDFDocument.load(data, { updateMetadata: false });
      pageCount = pdf.getPageCount();
      // Extract per-page text for the FTS index. Done here in pre-flight so
      // a failure in any one PDF aborts the whole batch (matches the existing
      // "validate everything before any side effect" contract).
      pagesText = await extractPagesText(data, fileName);
      if (pagesText.length !== pageCount) {
        errors.push(
          `"${fileName}": pdf-lib reports ${pageCount} pages but pdfjs extracted ${pagesText.length}`,
        );
        continue;
      }
    } catch (e: any) {
      errors.push(`"${fileName}": failed to read/parse PDF: ${e.message}`);
      continue;
    }

    rows.push({
      n,
      slug,
      sortOrder: n,
      title: meta.title,
      instructor: meta.instructor,
      filePath,
      fileName,
      r2Key: `lectures/${slug}.pdf`,
      pageCount,
      bytes,
      pagesText,
    });
  }

  // Sanity: warn if the expected 7 lectures are not all present.
  const metaKeys = Object.keys(LECTURE_META).map(Number).sort((a, b) => a - b);
  const missing = metaKeys.filter((k) => !rows.some((r) => r.n === k));
  if (missing.length > 0) {
    console.warn(`⚠ LECTURE_META defines ${metaKeys.join(',')} but no PDF found for: ${missing.join(',')}`);
  }

  if (errors.length > 0) {
    console.error(`\n❌ Pre-flight failed (${errors.length} error(s)):`);
    for (const e of errors) console.error('  ' + e);
    process.exit(2);
  }

  console.log(`✓ Pre-flight OK: ${rows.length} lecture(s) ready.\n`);

  // ---------- Upload to R2 ----------
  for (const r of rows) {
    const objRef = `${R2_BUCKET}/${r.r2Key}`;
    const exists = !force && (await r2ObjectExists(objRef, remote));
    if (exists) {
      console.log(`  R2 skip   ${r.r2Key} (exists; use --force to overwrite)`);
    } else {
      console.log(`  R2 put    ${r.r2Key}  (${kb(r.bytes)} KB)`);
      await sh('wrangler', [
        'r2', 'object', 'put', objRef,
        '--file', r.filePath,
        '--content-type', 'application/pdf',
        mode,
      ]);
    }
  }

  // ---------- Upsert lecture_docs + replace lecture_pages ----------
  // One SQL file for the whole batch: upsert lecture_docs (idempotent), then
  // for each lecture DELETE its existing lecture_pages rows and re-insert
  // current per-page text. The migration 0016 triggers fan out into
  // lecture_pages_fts automatically — we never touch the FTS table directly.
  const now = Date.now();
  const statements: string[] = [];
  let totalPages = 0;
  for (const r of rows) {
    statements.push(buildUpsert(r, now));
    statements.push(`DELETE FROM lecture_pages WHERE slug = '${escape(r.slug)}';`);
    for (let i = 0; i < r.pagesText.length; i++) {
      const page = i + 1;
      const text = r.pagesText[i] ?? '';
      statements.push(
        `INSERT INTO lecture_pages (slug, page, text) VALUES ('${escape(r.slug)}', ${page}, '${escape(text)}');`,
      );
      totalPages++;
    }
  }
  const sqlFile = '/tmp/import-lectures.sql';
  const { writeFile } = await import('node:fs/promises');
  await writeFile(sqlFile, statements.join('\n'), 'utf-8');
  console.log(
    `\n  D1 upsert ${rows.length} lecture_docs row(s) + ${totalPages} lecture_pages row(s) (${mode})`,
  );
  await sh('wrangler', ['d1', 'execute', D1_DB, mode, '--file', sqlFile]);

  // ---------- Summary ----------
  console.log('\n✅ Import complete.\n');
  console.log('  slug        pages   KB     title');
  console.log('  ' + '-'.repeat(64));
  for (const r of rows) {
    console.log(
      `  ${r.slug.padEnd(11)} ${String(r.pageCount).padStart(5)}  ${String(kb(r.bytes)).padStart(6)}  ${r.title}`,
    );
  }
}

function kb(bytes: number): number {
  return Math.round(bytes / 1024);
}

function escape(s: string): string {
  return s.replace(/'/g, "''");
}

function buildUpsert(r: LectureRow, now: number): string {
  return `INSERT INTO lecture_docs (slug, title, instructor, sort_order, r2_key, page_count, bytes, created_at)
VALUES ('${escape(r.slug)}', '${escape(r.title)}', '${escape(r.instructor)}', ${r.sortOrder}, '${escape(r.r2Key)}', ${r.pageCount}, ${r.bytes}, ${now})
ON CONFLICT(slug) DO UPDATE SET
  title = excluded.title,
  instructor = excluded.instructor,
  sort_order = excluded.sort_order,
  r2_key = excluded.r2_key,
  page_count = excluded.page_count,
  bytes = excluded.bytes;`;
}

/**
 * Returns true if the R2 object already exists. Uses `wrangler r2 object get`
 * to /dev/null and inspects the exit code (non-zero = missing/error).
 */
function r2ObjectExists(objRef: string, remote: boolean): Promise<boolean> {
  return new Promise((resolve) => {
    const args = ['r2', 'object', 'get', objRef, '--file', '/dev/null', remote ? '--remote' : '--local'];
    const p = spawn('wrangler', args, { stdio: 'ignore' });
    p.on('exit', (code) => resolve(code === 0));
    p.on('error', () => resolve(false));
  });
}

function sh(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: 'inherit' });
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
  });
}

/**
 * Extract per-page plaintext from a PDF using pdfjs-dist's Node-friendly
 * legacy build. Returns one string per page; multi-whitespace collapsed.
 * Used to populate lecture_pages (which fans out to lecture_pages_fts via
 * the trigger added in migration 0016).
 *
 * Worker: the legacy build runs with a fake worker by default in Node, so
 * no GlobalWorkerOptions.workerSrc is required. We disable font/eval paths
 * we don't need for text-only extraction.
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

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

#!/usr/bin/env node
/**
 * Import a reference textbook (Wintrobe 15e) into R2 + D1 for the
 * 「選字問 Wintrobe」textbook-citations feature.
 *
 * Usage:
 *   node --experimental-strip-types scripts/import-textbook.ts \
 *     --master <path-to-master.pdf> [--chapters 76,83,92] [--remote] [--force]
 *
 *   --master <p>    the full textbook PDF (git-ignored; lives on disk / R2 only)
 *   --chapters ...  comma-separated chapter numbers to import (default: ALL 108).
 *                   Use a small subset for a pilot before the full run.
 *   --remote        target prod R2 + D1 (default: local .wrangler/state)
 *   --force         re-upload to R2 even if the object already exists
 *
 * Reuses the lecture pipeline (migration 0016): each chapter becomes one
 * lecture_docs row with kind='textbook' (migration 0033), and its per-page
 * text lands in lecture_pages → lecture_pages_fts via the trigger. No new FTS
 * table — this calibre PDF is ~300 words/page, already passage-grained.
 *
 * For each selected chapter (from scripts/wintrobe-chapters.json):
 *   slug        = 'wintrobe-ch' + N
 *   sort_order  = N
 *   title       = 'Wintrobe ChN · <chapter title>'
 *   r2_key      = 'textbooks/' + slug + '.pdf'
 *   kind        = 'textbook'
 *   page_count  — from the split PDF (must equal end-start+1)
 *
 * The chapter PDF is cut from the master with `qpdf --linearize --pages`
 * (linearised for fast first-byte streaming), page numbers restart at 1 per
 * chapter — so (slug, local_page) maps directly onto the reader deep-link
 * /lectures/:slug?page=N and onto lecture_pages.(slug, page).
 *
 * Mirrors scripts/import-lectures.ts: pre-flight the WHOLE batch (split,
 * parse, extract) BEFORE any upload or insert; a single failure aborts.
 */

import { readFile, stat, mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { PDFDocument } from 'pdf-lib';
import { cfg } from './lib/cfg.mjs';

// pdfjs-dist legacy build for Node — per-page text extraction, same as
// scripts/import-lectures.ts. pdf-lib does not extract text.
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

const D1_DB = cfg('project.d1_db') as string;
const R2_BUCKET = cfg('project.r2_bucket') as string;

type Chapter = {
  n: number;
  slug: string;
  title: string;
  chapter: string;
  start: number;
  end: number;
  pages: number;
};

type Manifest = {
  source: string;
  index_page: number;
  chapters: Chapter[];
};

type TextbookRow = {
  slug: string;
  sortOrder: number;
  title: string;
  filePath: string; // split chapter PDF in the temp dir
  r2Key: string;
  pageCount: number;
  bytes: number;
  // Per-page normalised plaintext (index = page - 1). Length === pageCount.
  pagesText: string[];
};

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const remote = args.includes('--remote');
  const mode = remote ? '--remote' : '--local';

  const masterArg = args[args.indexOf('--master') + 1];
  if (!args.includes('--master') || !masterArg || masterArg.startsWith('--')) {
    console.error('❌ --master <path-to-master.pdf> is required');
    process.exit(1);
  }
  const master = resolve(masterArg);

  const chaptersArg = args[args.indexOf('--chapters') + 1];
  const wantChapters =
    args.includes('--chapters') && chaptersArg && !chaptersArg.startsWith('--')
      ? new Set<number>(
          chaptersArg
            .split(',')
            .map((s: string) => parseInt(s.trim(), 10))
            .filter((n: number) => Number.isFinite(n)),
        )
      : null; // null = all

  // ---------- Load manifest ----------
  const manifestPath = fileURLToPath(new URL('wintrobe-chapters.json', import.meta.url));
  const manifestRaw = await readFile(manifestPath, 'utf-8').catch((e: any) => {
    console.error(`❌ Cannot read ${manifestPath}: ${e.message}`);
    process.exit(1);
  });
  const manifest = JSON.parse(manifestRaw) as Manifest;

  const selected = manifest.chapters
    .filter((c) => (wantChapters ? wantChapters.has(c.n) : true))
    .sort((a, b) => a.n - b.n);

  if (selected.length === 0) {
    console.error('❌ No chapters selected (check --chapters against the manifest)');
    process.exit(1);
  }
  if (wantChapters) {
    const found = new Set(selected.map((c) => c.n));
    const missing = [...wantChapters].filter((n) => !found.has(n));
    if (missing.length) {
      console.error(`❌ --chapters includes unknown chapter number(s): ${missing.join(',')}`);
      process.exit(1);
    }
  }

  console.log(`📖 Importing ${selected.length} chapter(s) from ${master} (${mode}${force ? ', --force' : ''})`);
  console.log(`   D1=${D1_DB}  R2=${R2_BUCKET}`);

  try {
    await stat(master);
  } catch {
    console.error(`❌ Master PDF not found: ${master}`);
    process.exit(1);
  }

  const workDir = await mkdtemp(join(tmpdir(), 'textbook-import-'));

  try {
    // ---------- Pre-flight: split + parse + extract every chapter ----------
    const errors: string[] = [];
    const rows: TextbookRow[] = [];

    for (const c of selected) {
      const slug = c.slug;
      const outPath = join(workDir, `${slug}.pdf`);
      const expectedPages = c.end - c.start + 1;

      try {
        // Cut the chapter from the master, linearised for range streaming.
        // qpdf page selection is 1-based and inclusive; local pages restart at 1.
        await sh('qpdf', [
          '--linearize',
          master,
          '--pages', master, `${c.start}-${c.end}`,
          '--',
          outPath,
        ]);

        const st = await stat(outPath);
        const bytes = st.size;
        const data = await readFile(outPath);
        const pdf = await PDFDocument.load(data, { updateMetadata: false });
        const pageCount = pdf.getPageCount();
        if (pageCount !== expectedPages) {
          errors.push(`ch${c.n} (${slug}): expected ${expectedPages} pages (p${c.start}-${c.end}) but split has ${pageCount}`);
          continue;
        }
        const pagesText = await extractPagesText(data, slug);
        if (pagesText.length !== pageCount) {
          errors.push(`ch${c.n} (${slug}): ${pageCount} pages but pdfjs extracted ${pagesText.length}`);
          continue;
        }
        // Guard against a text-less (scanned) chapter slipping through.
        const nonEmpty = pagesText.filter((t) => t.length > 0).length;
        if (nonEmpty === 0) {
          errors.push(`ch${c.n} (${slug}): extracted zero text on all ${pageCount} pages (no text layer? needs OCR)`);
          continue;
        }

        rows.push({
          slug,
          sortOrder: c.n,
          title: c.title,
          filePath: outPath,
          r2Key: `textbooks/${slug}.pdf`,
          pageCount,
          bytes,
          pagesText,
        });
        console.log(`  ✓ ch${String(c.n).padStart(3)}  ${slug.padEnd(16)} ${String(pageCount).padStart(4)}pg  ${kb(bytes)}KB  (${nonEmpty} pages w/ text)`);
      } catch (e: any) {
        errors.push(`ch${c.n} (${slug}): split/parse failed: ${e.message}`);
      }
    }

    if (errors.length > 0) {
      console.error(`\n❌ Pre-flight failed (${errors.length} error(s)):`);
      for (const e of errors) console.error('  ' + e);
      process.exit(2);
    }

    console.log(`\n✓ Pre-flight OK: ${rows.length} chapter(s) ready.\n`);

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

    // ---------- Upsert lecture_docs (kind='textbook') + replace lecture_pages ----------
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
    const sqlFile = join(workDir, 'import-textbook.sql');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(sqlFile, statements.join('\n'), 'utf-8');
    console.log(
      `\n  D1 upsert ${rows.length} lecture_docs row(s) + ${totalPages} lecture_pages row(s) (${mode})`,
    );
    await sh('wrangler', ['d1', 'execute', D1_DB, mode, '--file', sqlFile]);

    // ---------- Summary ----------
    console.log('\n✅ Textbook import complete.\n');
    console.log('  slug              pages   KB     title');
    console.log('  ' + '-'.repeat(72));
    for (const r of rows) {
      console.log(
        `  ${r.slug.padEnd(16)} ${String(r.pageCount).padStart(5)}  ${String(kb(r.bytes)).padStart(6)}  ${r.title}`,
      );
    }
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

function kb(bytes: number): number {
  return Math.round(bytes / 1024);
}

function escape(s: string): string {
  return s.replace(/'/g, "''");
}

function buildUpsert(r: TextbookRow, now: number): string {
  return `INSERT INTO lecture_docs (slug, title, instructor, sort_order, r2_key, page_count, bytes, created_at, kind)
VALUES ('${escape(r.slug)}', '${escape(r.title)}', NULL, ${r.sortOrder}, '${escape(r.r2Key)}', ${r.pageCount}, ${r.bytes}, ${now}, 'textbook')
ON CONFLICT(slug) DO UPDATE SET
  title = excluded.title,
  instructor = excluded.instructor,
  sort_order = excluded.sort_order,
  r2_key = excluded.r2_key,
  page_count = excluded.page_count,
  bytes = excluded.bytes,
  kind = excluded.kind;`;
}

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
    p.on('error', (e) => reject(e));
  });
}

/**
 * Normalise a page's extracted text for the FTS index.
 *
 * The calibre EPUB→PDF conversion peppers words with U+00AD SOFT HYPHEN
 * (line-break hints) and uses U+2011 NON-BREAKING HYPHEN / U+2212 MINUS for
 * real hyphens. Left raw, "T‑cell" tokenises inconsistently vs a clean
 * "T-cell" query. Fold every hyphen-family code point to ASCII '-', which
 * the FTS5 unicode61 tokenizer treats as a token boundary — so both corpus
 * and query split "T-cell" → [t, cell] identically. Best recall for the
 * hyphenated compounds (T-cell, B-cell, non-Hodgkin, …) that dominate here.
 */
function normalizeText(s: string): string {
  return s
    .replace(/[­‐‑‒–—−]/g, '-') // hyphen/dash family → '-'
    .replace(/[‘’]/g, "'") // curly single quotes → '
    .replace(/[“”]/g, '"') // curly double quotes → "
    .replace(/\s+/g, ' ')
    .trim();
}

async function extractPagesText(buffer: Buffer, slug: string): Promise<string[]> {
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
      const text = normalizeText(
        tc.items
          .map((it: any) => (typeof it.str === 'string' ? it.str : ''))
          .join(' '),
      );
      out.push(text);
    }
  } catch (e: any) {
    throw new Error(`pdfjs text extraction failed on "${slug}" page ${out.length + 1}: ${e.message}`);
  } finally {
    await pdf.cleanup();
  }
  return out;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

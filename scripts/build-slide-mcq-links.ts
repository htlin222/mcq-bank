#!/usr/bin/env node
/**
 * Build 講義投影片 → 歷屆考題 links into `lecture_page_questions`.
 *
 * Usage:
 *   node --experimental-strip-types scripts/build-slide-mcq-links.ts [--remote] [--local] [--slug=<slug>] [--dry-run]
 *
 *   --remote      write to prod D1 (default: --local — algo per design §4 is
 *                 "算完寫本機 D1，驗證後再 --remote 推上去")
 *   --local       explicit local (same as omitting both flags)
 *   --slug=<slug> only rebuild one lecture (kind='lecture') — for a single
 *                 re-import instead of a full rebuild
 *   --dry-run     run recall + LLM judging, print counts, write NOTHING to D1
 *
 * What it does, per `kind='lecture'` slug × page (idempotent — re-running
 * overwrites that slug's rows entirely):
 *   1. Skip pages with < MIN_PAGE_TEXT_LEN chars of text (title/transition
 *      slides — design §4.1).
 *   2. Recall candidates from three unioned sources (design §4.2), mirroring
 *      the union pattern in worker/routes/questions.ts's `/:id/similar` +
 *      worker/lib/similar.ts:
 *        - semantic: embed the page text with EMBED_MODEL and cosine-rank
 *          against the question bank, embedded once in-memory here
 *          (self-contained — does not depend on Vectorize being backfilled)
 *        - lexical: OR-joined keyword MATCH against `questions_fts`
 *        - tag: `question_tags` whose tag text literally appears on the slide
 *   3. LLM-judge each candidate ("does this MCQ test this slide's content?")
 *      via TEXT_MODEL, temperature 0, structured JSON output. Keep relevant=true.
 *   4. Sort by score, keep top 6, DELETE-then-INSERT the whole slug's rows.
 *
 * Powers the reader's 「歷屆考題」 panel — see
 * docs/plans/2026-07-23-slide-mcq-links-design.md.
 *
 * Env (same as scripts/backfill-vectors.ts):
 *   CLOUDFLARE_ACCOUNT_ID / CF_ACCOUNT_ID   — account id
 *   CLOUDFLARE_API_TOKEN  / CF_API_TOKEN    — token needs Workers AI Read
 *                                             (embed + judge model calls)
 *
 * NOTE: this is a one-time/occasional remote write. Run --dry-run first,
 * then --local, then --remote once satisfied.
 */

import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { cfg } from './lib/cfg.mjs';
import { EMBED_MODEL, TEXT_MODEL } from '../worker/lib/ai-models.ts';

const D1_DB = cfg('project.d1_db') as string;

const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID || process.env.CF_ACCOUNT_ID || '';
const API_TOKEN = process.env.CLOUDFLARE_API_TOKEN || process.env.CF_API_TOKEN || '';

const EMBED_DIMS = 768;
const EMBED_BATCH = 50; // texts per AI embed call
const RECALL_K = 30; // per-source candidate cap ("K≈30", design §4.2)
const TOP_N_PER_PAGE = 6; // design §4.4
const MIN_PAGE_TEXT_LEN = 20; // design §4.1
const JUDGE_CONCURRENCY = 4;

interface QuestionRow {
  id: string;
  year: number;
  group: string | null;
  stem: string;
  options_json: string;
  tags: string | null; // GROUP_CONCAT, comma-separated
}

interface EmbeddedQuestion {
  id: string;
  vector: number[];
}

interface PageRow {
  page: number;
  text: string;
}

// The design's migration comment enumerates method as 'llm' | 'fts' | 'tag'
// (no separate 'vec' value) — since every surviving candidate is ultimately
// approved by the LLM judge regardless of origin, we read 'llm' as "surfaced
// by the embedding/semantic channel" and reserve 'fts'/'tag' for the two
// lexical/structured recall channels, matching that enum literally.
type Method = 'llm' | 'fts' | 'tag';

interface Candidate {
  id: string;
  method: Method;
}

interface JudgeVerdict {
  relevant: boolean;
  score: number;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const remote = args.includes('--remote');
  const mode = remote ? '--remote' : '--local';
  const slugFilter = args.find((a) => a.startsWith('--slug='))?.slice('--slug='.length);

  console.log(
    `🔗 Build slide→MCQ links (${mode}${dryRun ? ', DRY-RUN' : ''}${slugFilter ? `, slug=${slugFilter}` : ''})`,
  );
  console.log(`   D1=${D1_DB}  embed=${EMBED_MODEL}  judge=${TEXT_MODEL}`);

  if (!ACCOUNT_ID || !API_TOKEN) {
    console.error(
      '❌ CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN must be exported in this shell.\n' +
        '   The token needs Workers AI (Read) for embedding + judging.',
    );
    process.exit(2);
  }

  // ── Load + embed the full question bank once (self-contained semantic
  // recall — design §4.2 chose this over depending on Vectorize already
  // being backfilled). ──
  console.log('\n📚 Loading question bank…');
  const qRows = await d1Json<QuestionRow>(
    `SELECT q.id, q.year, q."group" AS "group", q.stem, q.options_json,
            (SELECT GROUP_CONCAT(tag, ',') FROM question_tags t WHERE t.question_id = q.id) AS tags
     FROM questions q ORDER BY q.year DESC, q.number ASC;`,
    mode,
  );
  if (qRows.length === 0) {
    console.error('❌ No questions found in D1.');
    process.exit(2);
  }
  const questionsById = new Map(qRows.map((q) => [q.id, q]));
  console.log(`   ${qRows.length} question(s) loaded.`);

  console.log('🧮 Embedding question bank…');
  const qEmbeddings: EmbeddedQuestion[] = [];
  for (let i = 0; i < qRows.length; i += EMBED_BATCH) {
    const batch = qRows.slice(i, i + EMBED_BATCH);
    const vectors = await embed(batch.map(questionEmbedText));
    batch.forEach((q, j) => {
      const values = vectors[j];
      if (!Array.isArray(values) || values.length !== EMBED_DIMS) {
        throw new Error(`bad embedding for ${q.id}: got ${values?.length} dims, expected ${EMBED_DIMS}`);
      }
      qEmbeddings.push({ id: q.id, vector: values });
    });
    console.log(`   embedded ${Math.min(i + EMBED_BATCH, qRows.length)}/${qRows.length}`);
  }

  // ── tag → question ids, for the tag recall source ──
  const tagRows = await d1Json<{ question_id: string; tag: string }>(
    'SELECT question_id, tag FROM question_tags;',
    mode,
  );
  const tagToQuestions = new Map<string, string[]>();
  for (const r of tagRows) {
    const list = tagToQuestions.get(r.tag) ?? [];
    list.push(r.question_id);
    tagToQuestions.set(r.tag, list);
  }
  // Longest-first so e.g. a matched "急性淋巴性白血病" isn't shadowed out by
  // also separately matching a shorter substring tag.
  const allTags = [...tagToQuestions.keys()].sort((a, b) => b.length - a.length);
  console.log(`   ${allTags.length} distinct tag(s) across ${tagRows.length} row(s).`);

  // ── slugs to (re)build ──
  const slugRows = await d1Json<{ slug: string }>(
    slugFilter
      ? `SELECT slug FROM lecture_docs WHERE kind = 'lecture' AND slug = '${escape(slugFilter)}' ORDER BY sort_order;`
      : `SELECT slug FROM lecture_docs WHERE kind = 'lecture' ORDER BY sort_order;`,
    mode,
  );
  if (slugRows.length === 0) {
    console.error(
      slugFilter ? `❌ No kind='lecture' doc with slug "${slugFilter}".` : "❌ No kind='lecture' docs found.",
    );
    process.exit(2);
  }
  console.log(`\n📖 ${slugRows.length} lecture(s) to process.`);

  let totalLinks = 0;
  for (const { slug } of slugRows) {
    console.log(`\n— ${slug} —`);
    const pages = await d1Json<PageRow>(
      `SELECT page, text FROM lecture_pages WHERE slug = '${escape(slug)}' ORDER BY page;`,
      mode,
    );

    const rows: { page: number; question_id: string; score: number; rank: number; method: Method }[] = [];

    for (const p of pages) {
      const text = (p.text ?? '').trim();
      if (text.length < MIN_PAGE_TEXT_LEN) continue; // title / transition slide

      const candidates = await recallCandidates(text, qEmbeddings, tagToQuestions, allTags, mode);
      if (candidates.length === 0) continue;

      const judged: { id: string; score: number; method: Method }[] = [];
      await mapPool(candidates, JUDGE_CONCURRENCY, async (cand) => {
        const q = questionsById.get(cand.id);
        if (!q) return;
        const verdict = await judge(text, q);
        if (verdict?.relevant) {
          judged.push({ id: cand.id, score: verdict.score, method: cand.method });
        }
      });

      judged.sort((a, b) => b.score - a.score);
      const kept = judged.slice(0, TOP_N_PER_PAGE);
      kept.forEach((j, rank) => {
        rows.push({ page: p.page, question_id: j.id, score: j.score, rank, method: j.method });
      });

      console.log(
        `   p.${p.page}: ${candidates.length} candidate(s) → ${judged.length} relevant → kept ${kept.length}`,
      );
    }

    totalLinks += rows.length;

    if (dryRun) {
      console.log(`   DRY-RUN: would write ${rows.length} link(s) for ${slug} (no D1 write).`);
      continue;
    }

    // Delete-then-insert the whole slug — idempotent, safe to re-run
    // (design §3/§9). Runs even when rows.length === 0, so a re-import that
    // no longer matches anything still clears stale links.
    const now = Date.now();
    const statements = [`DELETE FROM lecture_page_questions WHERE slug = '${escape(slug)}';`];
    for (const r of rows) {
      statements.push(
        `INSERT INTO lecture_page_questions (slug, page, question_id, score, rank, method, created_at)
         VALUES ('${escape(slug)}', ${r.page}, '${escape(r.question_id)}', ${r.score}, ${r.rank}, '${r.method}', ${now});`,
      );
    }
    const file = `/tmp/slide-mcq-links-${slug}.sql`;
    await writeFile(file, statements.join('\n'), 'utf-8');
    await sh('wrangler', ['d1', 'execute', D1_DB, mode, '--file', file]);
    console.log(`   wrote ${rows.length} link(s) for ${slug} (${mode}).`);
  }

  console.log(`\n✅ Done. ${totalLinks} link(s) total${dryRun ? ' (dry-run, nothing written)' : ` (${mode})`}.`);
}

/** Union the three recall sources for one page's text into deduped candidates. */
async function recallCandidates(
  pageText: string,
  qEmbeddings: EmbeddedQuestion[],
  tagToQuestions: Map<string, string[]>,
  allTags: string[],
  mode: string,
): Promise<Candidate[]> {
  const seen = new Set<string>();
  const out: Candidate[] = [];
  const push = (id: string, method: Method) => {
    if (seen.has(id)) return;
    seen.add(id);
    out.push({ id, method });
  };

  // Source 1: semantic — cosine over the in-memory question bank.
  const [pageVec] = await embed([pageText]);
  const scored = qEmbeddings
    .map((q) => ({ id: q.id, score: cosine(pageVec, q.vector) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, RECALL_K);
  for (const s of scored) push(s.id, 'llm');

  // Source 2: lexical — OR-joined keyword MATCH against questions_fts.
  const keywords = extractKeywords(pageText, 15);
  if (keywords.length > 0) {
    const ftsExpr = keywords.map((t) => (/^[A-Za-z0-9]+$/.test(t) ? `${t}*` : `"${t}"`)).join(' OR ');
    const ftsRows = await d1Json<{ question_id: string }>(
      `SELECT question_id FROM questions_fts WHERE questions_fts MATCH '${escape(ftsExpr)}'
       ORDER BY bm25(questions_fts) LIMIT ${RECALL_K};`,
      mode,
    );
    for (const r of ftsRows) push(r.question_id, 'fts');
  }

  // Source 3: tag overlap — tags whose literal text appears on the slide.
  const hitTags = allTags.filter((t) => pageText.includes(t)).slice(0, 10);
  for (const t of hitTags) {
    for (const id of (tagToQuestions.get(t) ?? []).slice(0, RECALL_K)) push(id, 'tag');
  }

  return out;
}

/** Workers AI REST: does this MCQ test this slide's content? Temperature 0, structured JSON. */
async function judge(pageText: string, q: QuestionRow): Promise<JudgeVerdict | null> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/ai/run/${TEXT_MODEL}`;
  const body = {
    temperature: 0,
    max_tokens: 200,
    response_format: {
      type: 'json_schema',
      json_schema: {
        type: 'object',
        properties: {
          relevant: { type: 'boolean' },
          score: { type: 'number' },
        },
        required: ['relevant', 'score'],
        additionalProperties: false,
      },
    },
    messages: [
      {
        role: 'system',
        content:
          '你是醫學考試出題委員。給你一張講義投影片的文字內容，以及一道歷屆考題。' +
          '判斷「這題是否在測驗這張投影片教的內容」——投影片內容要能直接幫助作答這題，' +
          '不是泛泛的科別相關而已。只輸出 JSON：{"relevant": boolean, "score": 0 到 1 的相關度}。',
      },
      {
        role: 'user',
        content: `投影片內容：\n${pageText.slice(0, 2000)}\n\n考題：\n${questionJudgeText(q)}`,
      },
    ],
  };

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${API_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`judge failed ${res.status}: ${await res.text()}`);
      const json = (await res.json()) as {
        success: boolean;
        result?: { response?: unknown };
        errors?: unknown;
      };
      if (!json.success) throw new Error(`judge error: ${JSON.stringify(json.errors ?? json)}`);
      const parsed = parseJudgeResponse(json.result?.response);
      if (!parsed) throw new Error('judge returned unparseable response');
      return {
        relevant: !!parsed.relevant,
        score: Math.max(0, Math.min(1, Number(parsed.score) || 0)),
      };
    } catch (e) {
      if (attempt === 1) {
        console.warn(`   ⚠ judge failed for ${q.id}, treating as not relevant: ${String(e)}`);
        return null;
      }
    }
  }
  return null;
}

/** Structured-output responses may come back as a JSON string or an already-parsed object. */
function parseJudgeResponse(raw: unknown): JudgeVerdict | null {
  let val = raw;
  if (typeof val === 'string') {
    try {
      val = JSON.parse(val);
    } catch {
      return null;
    }
  }
  if (val && typeof val === 'object' && 'relevant' in val && 'score' in val) {
    return val as JudgeVerdict;
  }
  return null;
}

/** stem + options + tags — same shape as backfill-vectors.ts's embedText. */
function questionEmbedText(q: QuestionRow): string {
  return [q.stem, optionsText(q), q.tags ?? ''].filter(Boolean).join('\n');
}

/** Human-readable stem + lettered options for the LLM judge prompt. */
function questionJudgeText(q: QuestionRow): string {
  return [q.stem, optionsText(q)].filter(Boolean).join('\n');
}

function optionsText(q: QuestionRow): string {
  try {
    const parsed = JSON.parse(q.options_json) as { key: string; text: string }[];
    return parsed.map((o) => `${o.key}. ${o.text}`).join('\n');
  } catch {
    return '';
  }
}

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'this', 'that', 'are', 'was', 'were',
  'has', 'have', 'not', 'but', 'into', 'than', 'then', 'also', 'can', 'may',
  'its', 'their', 'they', 'which', 'when', 'what', 'you', 'your',
]);

/** Best-effort keyword extraction for the lexical recall source (design §4.2). */
function extractKeywords(text: string, max: number): string[] {
  const tokens = text.match(/[\p{L}\p{N}]+/gu) ?? [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tokens) {
    if (raw.length < 2) continue;
    const key = raw.toLowerCase();
    if (STOPWORDS.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(raw);
    if (out.length >= max) break;
  }
  return out;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Run `fn` over `items` with at most `limit` in flight at once. */
async function mapPool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/** Workers AI REST: returns one 768-dim vector per input text. */
async function embed(texts: string[]): Promise<number[][]> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/ai/run/${EMBED_MODEL}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${API_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: texts }),
  });
  if (!res.ok) throw new Error(`AI embed failed ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { success: boolean; result?: { data?: number[][] }; errors?: unknown };
  const data = json?.result?.data;
  if (!json.success || !Array.isArray(data)) {
    throw new Error(`AI embed error: ${JSON.stringify(json.errors ?? json)}`);
  }
  return data;
}

/** `wrangler d1 execute --json --command` → parsed rows. */
async function d1Json<T>(command: string, mode: string): Promise<T[]> {
  const out = await shCapture('wrangler', ['d1', 'execute', D1_DB, mode, '--json', '--command', command]);
  return JSON.parse(out)?.[0]?.results ?? [];
}

function escape(s: string): string {
  return s.replace(/'/g, "''");
}

function shCapture(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    p.stdout.on('data', (d) => {
      out += d.toString();
    });
    p.on('exit', (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} exited ${code}`))));
  });
}

function sh(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: 'inherit' });
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

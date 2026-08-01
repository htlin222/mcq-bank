import { Hono } from 'hono';
import type { AppContext } from '../types';
import { apiKeyMiddleware } from '../lib/apikey';
import { sanitizeNoteDoc, externalImages } from '../lib/note-doc';
import { sideloadImageToR2 } from '../lib/sideload';
import { MAX_NOTES_PER_QUESTION, resolveNoteSlot } from '../lib/notes';
import { ftsQuery } from './search';

export const mcqRoutes = new Hono<AppContext>();

// Own API-key auth — this router is registered before the Access middleware
// in index.ts, so it never inherits Access gating.
mcqRoutes.use('*', apiKeyMiddleware);

// GET /api/mcq/search?q=CML — keyword lookup for the /mcq skill, so a user can
// find a question by topic instead of remembering its 年-題號. Registered
// BEFORE `/:id` (which would otherwise swallow "search" as an id). Returns only
// id / 年-題號 / group / snippet — never the answer, so the skill's answer-reveal
// flow stays intact. Same FTS behaviour as /api/search: ASCII tokens become
// prefix matches AND'd together, so short abbreviations (CML, CMV, AML) hit far
// more reliably than spelled-out disease names.
mcqRoutes.get('/search', async (c) => {
  const q = (c.req.query('q') || '').trim();
  const year = c.req.query('year');
  const limit = Math.min(parseInt(c.req.query('limit') || '20'), 50);
  if (!q) return c.json({ items: [], q });

  const params: any[] = [ftsQuery(q)];
  let yearSql = '';
  if (year) {
    yearSql = 'AND q.year = ?';
    params.push(parseInt(year));
  }
  params.push(limit);

  try {
    const { results } = await c.env.DB.prepare(
      `SELECT q.id, q.year, q.number, q."group",
              snippet(questions_fts, 1, '<<', '>>', '…', 16) AS snippet
         FROM questions q
         JOIN questions_fts f ON f.rowid = q.rowid
        WHERE questions_fts MATCH ? ${yearSql}
        ORDER BY bm25(questions_fts) ASC, q.year DESC, q.number ASC
        LIMIT ?`,
    )
      .bind(...params)
      .all();
    return c.json({ items: results, q });
  } catch (e) {
    console.warn('mcq search failed:', String(e));
    return c.json({ error: 'search failed', q }, 400);
  }
});

// GET /api/mcq/:id — read-only single question with parsed options, answer,
// and the collaborative explanation rendered to markdown. `id` is the primary
// key, e.g. "114-001" (民國 year + 3-digit number).
mcqRoutes.get('/:id', async (c) => {
  const id = c.req.param('id');

  const q = await c.env.DB.prepare(
    `SELECT id, year, number, "group", stem, options_json, answer, difficulty, source
       FROM questions WHERE id = ?`
  )
    .bind(id)
    .first<{
      id: string;
      year: number;
      number: number;
      group: string | null;
      stem: string;
      options_json: string;
      answer: string;
      difficulty: number | null;
      source: string | null;
    }>();
  if (!q) return c.json({ error: 'question not found', id }, 404);

  const exp = await c.env.DB.prepare(
    `SELECT content_json, version, updated_by, updated_at
       FROM explanations WHERE question_id = ?`
  )
    .bind(id)
    .first<{
      content_json: string;
      version: number;
      updated_by: string | null;
      updated_at: number;
    }>();

  // Personal notes of the *authenticated* caller only — the email comes from
  // apiKeyMiddleware (HMAC-verified), never straight from the header, so one
  // member can never read another member's notes through this endpoint.
  // 一題可以有多則筆記(migration 0036),全部回傳並各自附上 slot,終端才看得
  // 到使用者在網頁上分則寫的東西。`personal_note` 保留成第一則:0.7.x 以前
  // 下載的 .skill 還在使用者機器上跑,它只認得那一個欄位。
  const { results: noteRows } = await c.env.DB.prepare(
    `SELECT slot, content_json, created_at, updated_at
       FROM personal_notes WHERE user_email = ? AND question_id = ? ORDER BY slot`
  )
    .bind(c.get('email'), id)
    .all<{ slot: number; content_json: string; created_at: number; updated_at: number }>();

  const notes = (noteRows ?? []).map((n) => {
    const markdown = tiptapToMarkdown(JSON.parse(n.content_json));
    return {
      slot: n.slot,
      title: noteTitle(markdown),
      markdown,
      created_at: n.created_at,
      updated_at: n.updated_at,
    };
  });

  return c.json({
    id: q.id,
    year: q.year,
    number: q.number,
    group: q.group,
    difficulty: q.difficulty,
    source: q.source,
    stem: q.stem,
    options: JSON.parse(q.options_json) as Array<{ key: string; text: string }>,
    answer: q.answer,
    explanation: exp
      ? {
          markdown: tiptapToMarkdown(JSON.parse(exp.content_json)),
          version: exp.version,
          updated_by: exp.updated_by,
          updated_at: exp.updated_at,
        }
      : null,
    personal_note: notes[0] ?? null,
    personal_notes: notes,
  });
});

// PUT /api/mcq/:id/note — write the *caller's own* personal note. Default is
// append (existing rich content from the web editor is preserved verbatim,
// new blocks go after a horizontal rule); `mode: "replace"` swaps the whole
// doc and echoes the previous content back so it survives in the terminal.
//
// `slot` picks which of the question's notes to write:
//   • 省略      — 第一則(最小的既存 slot);一則都沒有就建 slot 0。這是
//                0.7.x 的 .skill 與 enrich-note 批次腳本的行為,不能變。
//   • 數字      — 指定那一則,必須已經存在。不存在就回 404 並附上現有號碼,
//                而不是在中間開一個洞 —— 畫記與挖空快取都以 slot 定位。
//   • "new"     — 新開一則(號碼取現有最大值 +1,不重用刪掉的號碼)。
//
// Content comes as ONE of:
//   • `markdown` — plain markdown, converted with markdownToTiptap below
//   • `doc`      — a TipTap document the skill built from HTML (--html /
//                  --oe-url). Sanitized to the web editor's node set
//                  (lib/note-doc.ts); external images are sideloaded to R2
//                  so notes don't depend on expiring hotlinks.
const NOTE_MAX_CHARS = 32_000;
const NOTE_DOC_MAX_JSON = 400_000; // sanity cap for the raw doc payload
const MAX_SIDELOAD_IMAGES = 12;

mcqRoutes.put('/:id/note', async (c) => {
  const id = c.req.param('id');
  const email = c.get('email');

  let body: { markdown?: unknown; doc?: unknown; mode?: unknown; slot?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid JSON body' }, 400);
  }
  const markdown = typeof body.markdown === 'string' ? body.markdown.trim() : '';
  const mode = body.mode === 'replace' ? 'replace' : 'append';

  // 這裡不用 lib/notes 的 parseSlot():它把看不懂的值收斂成 0,對網頁那種
  // 「使用者按下拉選單」的來源是對的,但終端是手打的 —— 打錯號碼就把內容
  // 靜靜灌進別則筆記,比直接報錯糟糕得多。
  const wantsNew = body.slot === 'new';
  let askedSlot: number | null = null;
  if (!wantsNew && body.slot !== undefined && body.slot !== null) {
    const n = typeof body.slot === 'number' ? body.slot : Number(body.slot);
    if (!Number.isInteger(n) || n < 0 || n >= MAX_NOTES_PER_QUESTION)
      return c.json(
        { error: `slot must be an integer 0–${MAX_NOTES_PER_QUESTION - 1}, or "new"` },
        400
      );
    askedSlot = n;
  }
  if (!markdown && !body.doc)
    return c.json({ error: 'markdown or doc required' }, 400);
  if (markdown.length > NOTE_MAX_CHARS)
    return c.json({ error: `markdown too long (max ${NOTE_MAX_CHARS} chars)` }, 400);

  const warnings: string[] = [];
  let newBlocks: PMNode[];
  if (body.doc) {
    if (JSON.stringify(body.doc).length > NOTE_DOC_MAX_JSON)
      return c.json({ error: `doc too large (max ${NOTE_DOC_MAX_JSON} JSON chars)` }, 400);
    const sanitized = sanitizeNoteDoc(body.doc);
    if (!sanitized.ok) return c.json({ error: sanitized.error }, 400);
    if (sanitized.dropped.length)
      warnings.push(`dropped unsupported nodes: ${sanitized.dropped.join(', ')}`);

    // Persist hotlinked figures into R2 — mutates the image nodes in place.
    const pending = externalImages(sanitized.images);
    if (pending.length > MAX_SIDELOAD_IMAGES)
      warnings.push(
        `only first ${MAX_SIDELOAD_IMAGES} of ${pending.length} external images sideloaded`
      );
    for (const img of pending.slice(0, MAX_SIDELOAD_IMAGES)) {
      const src = String(img.attrs!.src);
      const result = await sideloadImageToR2(c.env, src, email);
      if (result.ok) img.attrs!.src = result.url;
      else warnings.push(`image kept as hotlink (${result.error}): ${src.slice(0, 120)}`);
    }
    newBlocks = sanitized.doc.content ?? [];
  } else {
    newBlocks = markdownToTiptap(markdown).content ?? [];
  }

  const exists = await c.env.DB.prepare('SELECT id FROM questions WHERE id = ?')
    .bind(id)
    .first();
  if (!exists) return c.json({ error: 'question not found', id }, 404);

  const { results: existing } = await c.env.DB.prepare(
    `SELECT slot, content_json FROM personal_notes
      WHERE user_email = ? AND question_id = ? ORDER BY slot`
  )
    .bind(email, id)
    .all<{ slot: number; content_json: string }>();
  const rows = existing ?? [];
  const pick = resolveNoteSlot(
    rows.map((r) => r.slot),
    wantsNew ? 'new' : askedSlot
  );
  if (!pick.ok)
    return c.json(
      {
        error: pick.error,
        slots: pick.slots,
        max: MAX_NOTES_PER_QUESTION,
        ...(pick.status === 404 ? { hint: 'use slot:"new" to add one' } : {}),
      },
      pick.status
    );
  const slot = pick.slot;

  const prev = pick.isNew ? undefined : rows.find((r) => r.slot === slot);
  let doc: PMNode;
  if (mode === 'append' && prev) {
    const prevDoc = JSON.parse(prev.content_json) as PMNode;
    doc = {
      type: 'doc',
      content: [...(prevDoc.content ?? []), { type: 'horizontalRule' }, ...newBlocks],
    };
  } else {
    doc = { type: 'doc', content: newBlocks };
  }

  const now = Date.now();
  await c.env.DB.prepare(
    `INSERT INTO personal_notes (user_email, question_id, slot, content_json, created_at, updated_at, needs_relink)
     VALUES (?, ?, ?, ?, ?, ?, 1)
     ON CONFLICT(user_email, question_id, slot) DO UPDATE SET
       content_json = excluded.content_json,
       updated_at   = excluded.updated_at,
       needs_relink = 1`
  )
    .bind(email, id, slot, JSON.stringify(doc), now, now)
    .run();

  const note_markdown = tiptapToMarkdown(doc);
  return c.json({
    ok: true,
    mode: prev ? mode : 'create',
    slot,
    title: noteTitle(note_markdown),
    notes_count: prev ? rows.length : rows.length + 1,
    updated_at: now,
    note_markdown,
    previous_markdown:
      mode === 'replace' && prev ? tiptapToMarkdown(JSON.parse(prev.content_json)) : null,
    ...(warnings.length ? { warnings } : {}),
  });
});

// 筆記的名字就是內文第一行 —— 沒有 title 欄位,網頁的切換下拉也是這樣取名的
// (frontend/src/lib/noteTitle.ts)。這裡從已經轉好的 markdown 取,省得再走一次
// TipTap 樹;結果對齊網頁,使用者在終端看到的名字就是他在下拉裡選的那個。
const NOTE_TITLE_MAX = 40;

function noteTitle(markdown: string, fallback = '未命名筆記'): string {
  const line = markdown
    .split('\n')
    .map((s) => s.trim())
    .find(Boolean);
  if (!line) return fallback;
  if (/^!\[/.test(line)) return '［圖片］';
  const plain = line
    .replace(/^#{1,6}\s*/, '')
    .replace(/^[-*+]\s+/, '')
    .replace(/^>\s*/, '')
    .replace(/[*`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!plain) return fallback;
  return plain.length > NOTE_TITLE_MAX ? `${plain.slice(0, NOTE_TITLE_MAX)}…` : plain;
}

// --- TipTap / ProseMirror JSON → markdown-ish plain text -------------------
type PMNode = {
  type?: string;
  text?: string;
  attrs?: Record<string, any>;
  marks?: Array<{ type: string; attrs?: Record<string, any> }>;
  content?: PMNode[];
};

// --- markdown → TipTap JSON (write path) -----------------------------------
// Only emits node types in the frontend's StarterKit set (paragraph, heading,
// lists, blockquote, codeBlock, horizontalRule) plus bold/italic/code marks,
// so the web editor can always open what the skill writes. Anything fancier
// in the input just survives as literal text.

function parseInline(text: string): PMNode[] {
  const nodes: PMNode[] = [];
  // **bold** / *italic* / `code`; unmatched markers fall through as text.
  const re = /(\*\*(.+?)\*\*|\*(.+?)\*|`(.+?)`)/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) nodes.push({ type: 'text', text: text.slice(last, m.index) });
    if (m[2] !== undefined)
      nodes.push({ type: 'text', text: m[2], marks: [{ type: 'bold' }] });
    else if (m[3] !== undefined)
      nodes.push({ type: 'text', text: m[3], marks: [{ type: 'italic' }] });
    else nodes.push({ type: 'text', text: m[4], marks: [{ type: 'code' }] });
    last = m.index + m[0].length;
  }
  if (last < text.length) nodes.push({ type: 'text', text: text.slice(last) });
  return nodes;
}

function paragraph(lines: string[]): PMNode {
  const content: PMNode[] = [];
  lines.forEach((line, i) => {
    if (i > 0) content.push({ type: 'hardBreak' });
    content.push(...parseInline(line));
  });
  return { type: 'paragraph', content };
}

function markdownToTiptap(md: string): PMNode {
  const blocks: PMNode[] = [];
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  let para: string[] = [];
  const flushPara = () => {
    if (para.length) blocks.push(paragraph(para));
    para = [];
  };

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      flushPara();
      i++;
      continue;
    }
    if (trimmed.startsWith('```')) {
      flushPara();
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) code.push(lines[i++]);
      i++; // closing fence (or EOF)
      blocks.push({
        type: 'codeBlock',
        content: code.length ? [{ type: 'text', text: code.join('\n') }] : [],
      });
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading) {
      flushPara();
      blocks.push({
        type: 'heading',
        attrs: { level: heading[1].length },
        content: parseInline(heading[2]),
      });
      i++;
      continue;
    }
    if (/^(-{3,}|\*{3,})$/.test(trimmed)) {
      flushPara();
      blocks.push({ type: 'horizontalRule' });
      i++;
      continue;
    }
    const bullet = /^[-*+]\s+(.*)$/.exec(trimmed);
    const ordered = /^\d+[.)]\s+(.*)$/.exec(trimmed);
    if (bullet || ordered) {
      flushPara();
      const listType = bullet ? 'bulletList' : 'orderedList';
      const itemRe = bullet ? /^[-*+]\s+(.*)$/ : /^\d+[.)]\s+(.*)$/;
      const items: PMNode[] = [];
      while (i < lines.length) {
        const m = itemRe.exec(lines[i].trim());
        if (!m) break;
        items.push({ type: 'listItem', content: [paragraph([m[1]])] });
        i++;
      }
      blocks.push({ type: listType, content: items });
      continue;
    }
    if (trimmed.startsWith('> ')) {
      flushPara();
      const quoted: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith('> '))
        quoted.push(lines[i++].trim().slice(2));
      blocks.push({ type: 'blockquote', content: [paragraph(quoted)] });
      continue;
    }
    para.push(trimmed);
    i++;
  }
  flushPara();
  if (!blocks.length) blocks.push(paragraph(['']));
  return { type: 'doc', content: blocks };
}

function tiptapToMarkdown(doc: PMNode): string {
  const walk = (n: PMNode | undefined): string => {
    if (!n) return '';
    const kids = (n.content ?? []).map(walk).join('');
    switch (n.type) {
      case 'doc':
        return kids;
      case 'paragraph':
        return kids + '\n\n';
      case 'text':
        return n.text ?? '';
      case 'heading':
        return '#'.repeat(n.attrs?.level ?? 1) + ' ' + kids + '\n\n';
      case 'bulletList':
      case 'orderedList':
        return kids + '\n';
      case 'listItem':
        return '- ' + kids.trim() + '\n';
      case 'hardBreak':
        return '\n';
      case 'blockquote':
        return '> ' + kids.trim() + '\n\n';
      case 'codeBlock':
        return '```\n' + kids + '\n```\n\n';
      case 'image':
        return `![](${n.attrs?.src ?? ''})\n`;
      case 'mention':
        return '@' + (n.attrs?.label ?? n.attrs?.id ?? '');
      default:
        return kids;
    }
  };
  return walk(doc).replace(/\n{3,}/g, '\n\n').trim();
}

# Design — 複習班講義 (Review-class lecture PDFs)

Date: 2026-05-30
Branch: `feat/review-lectures`
Status: Approved (brainstorm complete)

## Goal

A new top-level section **複習班講義** where users read the 7 review-class
lecture PDFs online in a feature-rich viewer, with **personal** highlights,
sticky notes, and a page-anchored notebook; a text-selection popup offering
Highlight / AI-explain / OpenEvidence / copy-to-note; and a snapshot button
that copies the current slide (with annotations) to the clipboard as an image.

Locked decisions (from brainstorm):

- **Annotations are personal/private** (per-user), like `personal_notes`.
- **Viewer = EmbedPDF** (`@embedpdf/*`, pdfium-wasm), lazy-loaded on the
  reader route only.
- **v1 annotation tools:** text highlight, margin/sticky notes, page-anchored
  free-form notebook. **No** freehand ink in v1.
- **Notebook model:** one notebook per lecture, each entry auto-tags the page
  you were on; filterable by page or read whole-deck. Single data model.
- **Selection popup actions:** Highlight · AI 解釋(zh-TW) · OpenEvidence · 複製到筆記.
- **AI action:** concise 繁體中文 explanation of the selection (Workers AI llama).
- **`@114-001` refs in notes:** reuse existing `questionRef` TipTap node →
  click navigates to `/q/114-001`. Not indexed into `question_refs` (privacy,
  consistent with `personal_notes`).
- **Nav:** add **講義** as 7th pill in the desktop top row (首頁/複習/全真/搜尋/
  收藏/錯題/**講義**). Full title 複習班講義 on the page. Home dashboard card for
  mobile reach. Mobile bottom bar stays at 5 icons.

## 1. Architecture & routing

- `/lectures` — index: card grid of 7 lectures (ordered by `1-1 … 7-1`
  prefix), each card shows title, instructor, page count, and the caller's
  annotation/note counts.
- `/lectures/:slug` — reader: EmbedPDF viewer (main) + collapsible right side
  panel (notebook + annotation list). Mobile: panel becomes a bottom sheet.
- Both route modules are `React.lazy()` + `<Suspense>` so EmbedPDF's
  pdfium-wasm (~1–2 MB) never loads on other routes.

**PDF serving — Zero-Trust preserved (never a public bucket):**

- The 7 PDFs (78 MB) live in **R2** under key prefix `lectures/`, uploaded by
  a one-time import script. They are **not** in the Pages bundle or git.
- New Worker proxy `GET /pdf/:key{.+}`, registered behind `authMiddleware`
  exactly like `/img`. Mirrors `worker/routes/images.ts` but **adds HTTP Range
  support** (`Range` request → `206` + `Content-Range`/`Accept-Ranges`),
  because pdfium requests byte ranges for lazy page loading. Path-traversal
  guard (`..`, leading `/`). `Cache-Control: private`.

**Document registry in D1** (`lecture_docs`), seeded by
`scripts/import-lectures.ts` (same spirit as `import-questions.ts`). Frontend
never hard-codes the file list — it fetches `GET /api/lectures`.

## 2. Data model (D1, migration `0014_lectures.sql`)

```sql
-- Shared registry (seeded by import script)
CREATE TABLE lecture_docs (
  slug        TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  instructor  TEXT,
  sort_order  INTEGER NOT NULL,
  r2_key      TEXT NOT NULL,
  page_count  INTEGER,
  bytes       INTEGER,
  created_at  INTEGER NOT NULL
);

-- Personal highlights + sticky notes (one row each)
CREATE TABLE lecture_annotations (
  id           TEXT PRIMARY KEY,
  user_email   TEXT NOT NULL REFERENCES users(email) ON DELETE CASCADE,
  slug         TEXT NOT NULL REFERENCES lecture_docs(slug) ON DELETE CASCADE,
  page         INTEGER NOT NULL,
  kind         TEXT NOT NULL,            -- 'highlight' | 'note'
  payload_json TEXT NOT NULL,            -- EmbedPDF geometry/color, or sticky text+anchor
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX idx_lecanno_user_slug_page ON lecture_annotations(user_email, slug, page);

-- Personal page-anchored notebook (TipTap)
CREATE TABLE lecture_notes (
  id           TEXT PRIMARY KEY,
  user_email   TEXT NOT NULL REFERENCES users(email) ON DELETE CASCADE,
  slug         TEXT NOT NULL REFERENCES lecture_docs(slug) ON DELETE CASCADE,
  page         INTEGER,                  -- NULL = deck-level note
  content_json TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX idx_lecnote_user_slug ON lecture_notes(user_email, slug);
```

Highlights/notes are **rows** (not one blob/doc) so the index page can cheaply
`COUNT` per slug and the side panel can filter by page.

## 3. API (`worker/routes/lectures.ts`, `app.route('/api/lectures', …)`)

Registry & file:
- `GET /api/lectures` — list ordered by `sort_order`, each joined with caller's
  annotation/note counts.
- `GET /api/lectures/:slug` — single doc metadata (+ derived `/pdf/<key>` URL).
- `GET /pdf/:key{.+}` — R2 stream with **Range support**; traversal guard.

Annotations (ownership-checked on every mutate, `user_email = c.var.email`):
- `GET /api/lectures/:slug/annotations`
- `POST /api/lectures/:slug/annotations`  `{ kind, page, payload_json }`
- `PATCH /api/lectures/:slug/annotations/:id`
- `DELETE /api/lectures/:slug/annotations/:id`

Notebook (ownership-checked):
- `GET /api/lectures/:slug/notes`
- `POST /api/lectures/:slug/notes`  `{ page|null, content_json }`
- `PATCH /api/lectures/:slug/notes/:id`
- `DELETE /api/lectures/:slug/notes/:id`

AI + OE for the selection popup:
- `POST /api/ai/explain-selection` `{ text }` → concise 繁體中文 explanation
  (extends `ai.ts`, reuses llama plumbing). Guard min length.
- OpenEvidence → **no endpoint**; frontend reuses `buildOpenEvidenceUrl`.

All handlers read identity via `c.var.email`; never trust body-supplied user.

## 4. Frontend

Route modules (lazy):
- `routes/Lectures.tsx` — index grid.
- `routes/LectureReader.tsx` — `/lectures/:slug`.

`LectureReader` composes:
- `<EmbedPDFViewer>` — wrapper over `@embedpdf/*` plugins (render, zoom,
  page-nav, text-selection). Loads from `/pdf/<key>` (same-origin → no canvas
  taint). `<Suspense>` skeleton while wasm boots.
- `<ReaderToolbar>` — page nav, zoom, **截圖 (Snapshot)**, panel toggle.
- `<SelectionPopup>` — anchored to selection rect; 4 actions: Highlight (POST
  annotation), **AI 解釋** (`/api/ai/explain-selection` → zh-TW popover),
  **OpenEvidence** (external `buildOpenEvidenceUrl`), **複製到筆記** (append
  selection into notebook, auto-tagged with current page).
- `<LecturePanel>` — right panel / mobile bottom sheet, two tabs: **筆記**
  (page-anchored TipTap notebook with `[全部 ▾]` page filter) and **標註**
  (list of highlights/sticky notes; click → jump to page).

Shared utilities:
- `lib/lectureApi.ts` — typed fetch wrappers (mirrors `lib/api.ts`).
- **Extract** `buildOpenEvidenceUrl` from `Question.tsx` into
  `lib/openevidence.ts`; both Question page and PDF popup import it (no dup).
- `lib/snapshot.ts` — `html-to-image` `toBlob` on the page-layer node
  (flattens canvas + annotation overlay) → `navigator.clipboard.write([
  new ClipboardItem({'image/png': blob})])`; fallback = auto-download PNG;
  success/fallback toasts.
- `hooks/useLectureAnnotations.ts`, `hooks/useLectureNotes.ts` — optimistic
  CRUD, same shape as existing hooks.

Notebook reuses the shared `Editor`/`ReadOnlyEditor` built from
`buildExtensions()`, so `@114-001` insertion (mention picker) and
click-to-`/q/:id` (App.tsx global interceptor) work for free.

**Snapshot feature:** toolbar camera button captures the current page
container (canvas + annotation overlay) cropped to slide bounds → PNG →
clipboard, with download fallback. Frontend-only, no persistence.

Nav: add `講義` `<NavItem to="/lectures">` (7th pill) in `App.tsx` desktop row;
register `<Route path="/lectures">` + `<Route path="/lectures/:slug">`; add a
複習班講義 card to the Home dashboard. Bottom bar unchanged (5 icons). Reuse
existing scholarly/editorial design language — no new visual style.

## 5. Import, config, testing

**`scripts/import-lectures.ts`** (mirrors `import-questions.ts`, reads
`config.toml` via `lib/cfg.mjs`):
1. Read 7 PDFs from `./pdf/`; parse `N-1_醫師_主題` filename → `sort_order`,
   `instructor`, `title` (small editable title map for clean display names).
2. Page count via `pdf-lib` (or pdfium); record `bytes`.
3. `wrangler r2 object put` each under `lectures/<slug>.pdf` (idempotent; skip
   existing unless `--force`).
4. Upsert `lecture_docs`. Pre-flight validates unique slugs before any insert
   (abort-on-failure like questions). Add `pnpm import:lectures`.

**Config:** `pdf/` source dir + `lectures/` R2 prefix are conventions, not
per-fork secrets → **no new `config.toml` keys**.

**Verification:**
- Worker: Range request → `206` + correct `Content-Range`; annotation/note CRUD
  enforces ownership (second user cannot read/edit another's rows); `/pdf`
  traversal guard.
- Frontend: `tsc -b` clean; EmbedPDF confirmed absent from the main bundle
  (lazy chunk); manual smoke — open lecture, highlight, sticky note,
  page-anchored note, `@114-001` ref click → review, selection→AI/OE/copy,
  snapshot→clipboard + download fallback.
- `.gitignore`: keep `pdf/` out of Pages deploy (lives in R2); verify not in
  the build output.

## Out of scope (YAGNI)

- Freehand ink/drawing annotations.
- Shared/collaborative annotation layer.
- Real-time co-editing of notes.
- OCR (PDFs already have a text layer).
- New per-fork config keys.

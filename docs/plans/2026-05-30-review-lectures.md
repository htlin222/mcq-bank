# 複習班講義 (Review-class Lecture PDFs) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a 複習班講義 section where users read 7 lecture PDFs in an EmbedPDF viewer with personal highlights, sticky notes, a page-anchored notebook, a text-selection popup (Highlight / AI 解釋 / OpenEvidence / 複製到筆記), and a snapshot-to-clipboard button.

**Architecture:** PDFs in R2 served via a Range-capable Worker proxy (`/pdf/:key`); D1 holds a shared `lecture_docs` registry plus per-user `lecture_annotations` and `lecture_notes`. Frontend uses EmbedPDF (pdfium-wasm) lazy-loaded only on the reader route. Annotations persist via EmbedPDF's `exportAnnotations()`/`importAnnotations()` round-trip stored as JSON. The notebook reuses the existing TipTap `buildExtensions()` so `@114-001` refs work for free.

**Tech Stack:** Cloudflare Worker (Hono), D1, R2, React 18 + Vite, EmbedPDF (`@embedpdf/*`), TipTap, `html-to-image`.

**Verification note:** This repo has **no test runner**. Verification = `pnpm typecheck` (frontend), `wrangler` local D1/route checks, and manual smoke. Commit after each task. Design ref: `docs/plans/2026-05-30-review-lectures-design.md`.

---

### Task 0: Install dependencies

**Files:** Modify `frontend/package.json`, `package.json` (root, for import script dev dep).

**Step 1:** In `frontend/`, install EmbedPDF + snapshot:
```bash
cd frontend && pnpm add @embedpdf/core @embedpdf/engines \
  @embedpdf/plugin-loader @embedpdf/plugin-viewport @embedpdf/plugin-scroll \
  @embedpdf/plugin-render @embedpdf/plugin-zoom @embedpdf/plugin-selection \
  @embedpdf/plugin-annotation html-to-image
```
(If a `@embedpdf/plugin-document-manager` / `@embedpdf/plugin-tiling` is required by peer deps, add it — confirm against `node_modules/@embedpdf/core/package.json` peerDependencies.)

**Step 2:** Root, for the import script PDF page count:
```bash
pnpm add -D pdf-lib
```

**Step 3:** `pnpm typecheck` in frontend → still PASS (no usage yet).

**Step 4:** Commit `chore: add EmbedPDF + html-to-image + pdf-lib deps`.

---

### Task 1: D1 migration `0014_lectures.sql`

**Files:** Create `migrations/0014_lectures.sql`.

**Step 1:** Write the three tables exactly as in the design doc §2 (`lecture_docs`, `lecture_annotations`, `lecture_notes` + their indexes).

**Step 2:** Apply locally:
```bash
pnpm db:migrate:local
wrangler d1 execute qa-db --local --command \
  "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'lecture%'"
```
Expected: 3 rows.

**Step 3:** Commit `feat(db): migration 0014 lecture tables`.

---

### Task 2: Worker `/pdf` Range-capable R2 proxy

**Files:** Create `worker/routes/pdf.ts`; modify `worker/index.ts`.

**Step 1:** Write `pdf.ts` modeled on `worker/routes/images.ts`, adding HTTP Range:
- Path-traversal guard (`includes('..')`, `startsWith('/')`).
- Parse `Range: bytes=start-end`. If present, `c.env.R2.get(key, { range: { offset, length } })`, respond `206` with `Content-Range: bytes start-end/total`, `Accept-Ranges: bytes`, `Content-Length` = chunk size.
- No Range → full object, `200`, `Accept-Ranges: bytes`.
- `Content-Type: application/pdf`, `Cache-Control: private, max-age=86400`, `ETag`.
- 404 when object missing.

**Step 2:** In `worker/index.ts`: add `app.use('/pdf/*', authMiddleware);` (next to the `/img/*` line ~51) and `app.route('/pdf', pdfRoutes);` (next to `/img` ~62), plus the import.

**Step 3:** Verify locally — put a test object and curl a range:
```bash
wrangler dev &  # then in another shell
curl -s -H "X-Dev-Email: <admin>" -H "Range: bytes=0-99" -D - http://localhost:8787/pdf/lectures/test.pdf -o /dev/null
```
Expected once an object exists: `HTTP/1.1 206` + `Content-Range`. (Object seeded in Task 5; for now assert 404 path + no crash.)

**Step 4:** Commit `feat(worker): Range-capable /pdf R2 proxy`.

---

### Task 3: Worker `lectures` routes (registry + annotations + notes)

**Files:** Create `worker/routes/lectures.ts`; modify `worker/index.ts`.

**Step 1:** Implement endpoints from design §3. Identity via `c.var.email`. Use `crypto.randomUUID()` for ids, `Date.now()` for timestamps.
- `GET /` — `SELECT * FROM lecture_docs ORDER BY sort_order`, left-join counts:
  ```sql
  SELECT d.*,
    (SELECT COUNT(*) FROM lecture_annotations a WHERE a.slug=d.slug AND a.user_email=?) AS anno_count,
    (SELECT COUNT(*) FROM lecture_notes n WHERE n.slug=d.slug AND n.user_email=?) AS note_count
  FROM lecture_docs d ORDER BY d.sort_order
  ```
- `GET /:slug` — single row + `pdf_url = '/pdf/' + r2_key`.
- Annotations CRUD on `lecture_annotations`, notes CRUD on `lecture_notes`; every mutate filters `WHERE id=? AND user_email=?` and returns 404 if no row changed.

**Step 2:** Register in `worker/index.ts`: `app.route('/api/lectures', lectureRoutes);` + import. (Auth middleware already covers `/api/*`.)

**Step 3:** Local checks with `wrangler d1 execute` to insert a dummy doc, then curl the endpoints with `X-Dev-Email`. Verify a second email cannot PATCH/DELETE another user's annotation (404).

**Step 4:** Commit `feat(worker): /api/lectures registry + personal annotations & notes`.

---

### Task 4: Worker AI explain-selection

**Files:** Modify `worker/routes/ai.ts`.

**Step 1:** Add `POST /explain-selection` `{ text }`: guard `text.length >= 10`, system prompt = "你是醫學教學助手，用繁體中文簡潔解釋以下投影片片段，2-4 句，必要時補充臨床意義。" user = the text. Reuse `TEXT_MODEL` + `c.env.AI.run`. Return `{ text: out.response }`.

**Step 2:** Curl local: `POST /api/ai/explain-selection` with sample text → zh-TW explanation.

**Step 3:** Commit `feat(worker): AI explain-selection for lecture text`.

---

### Task 5: Import script `scripts/import-lectures.ts`

**Files:** Create `scripts/import-lectures.ts`; modify `package.json` (root) scripts.

**Step 1:** Mirror `scripts/import-questions.ts` structure. Read `config.toml` via `./lib/cfg.mjs`. For each `pdf/*.pdf`:
- Parse filename `^(\d+)-\d+_?\s*(.+?醫師)?_(.+?)_?\(` → `sort_order` (leading int), `instructor`, raw `title`; provide an editable `TITLE_OVERRIDES` map keyed by sort_order for clean display titles.
- `slug = lecture-<sort_order>` (stable, ASCII).
- `page_count` via `pdf-lib` `PDFDocument.load(bytes).getPageCount()`; `bytes = buffer.length`.
- Upload: `wrangler r2 object put <bucket>/lectures/<slug>.pdf --file <path>` via `execSync` (skip if exists unless `--force`; check `wrangler r2 object get` head or list).
- Pre-flight: collect all rows first, assert unique slugs, THEN upsert `lecture_docs` (abort whole batch on any failure).

**Step 2:** Add `"import:lectures": "node --experimental-strip-types scripts/import-lectures.ts"` to root `package.json`.

**Step 3:** Run against local D1 (`--local`) and verify rows + that `/pdf/lectures/lecture-1.pdf` now serves `206` (re-run Task 2 Step 3).

**Step 4:** Commit `feat(scripts): import-lectures (R2 upload + lecture_docs seed)`.

---

### Task 6: Frontend shared libs

**Files:** Create `frontend/src/lib/lectureApi.ts`, `frontend/src/lib/openevidence.ts`, `frontend/src/lib/snapshot.ts`; modify `frontend/src/routes/Question.tsx`.

**Step 1:** **Extract** `buildOpenEvidenceUrl` (currently in `Question.tsx` ~line 660-680) into `lib/openevidence.ts` (exported). Update `Question.tsx` to import it; delete the local copy. `pnpm typecheck` PASS.

**Step 2:** `lectureApi.ts` — typed wrappers over `lib/api.ts` for every endpoint in Task 3/4 (list, get, annotations CRUD, notes CRUD, explainSelection). Export TS types `LectureDoc`, `LectureAnnotation`, `LectureNote`.

**Step 3:** `snapshot.ts` — `export async function snapshotToClipboard(node: HTMLElement)`: `const blob = await toBlob(node, { pixelRatio: 2, cacheBust: true })`; if `window.ClipboardItem` & `navigator.clipboard?.write` → write `image/png`, return `'clipboard'`; else trigger download (`<a download>`), return `'download'`. Throw → caller toasts error.

**Step 4:** `pnpm typecheck` PASS. Commit `refactor(fe): extract openevidence; add lectureApi + snapshot libs`.

---

### Task 7: EmbedPDF viewer wrapper + lazy routes + nav

**Files:** Create `frontend/src/components/lecture/EmbedPDFViewer.tsx`; modify `frontend/src/App.tsx`.

**Step 1:** `EmbedPDFViewer.tsx` — `'use client'`-style wrapper. Use `usePdfiumEngine()`; build plugin registrations (loader, viewport, scroll, render, zoom, selection, annotation) via `createPluginRegistration(...)` with `loader` configured to the `/pdf/<key>` URL (credentials: same-origin so the Access cookie rides along). Render `<EmbedPDF engine plugins>` containing `<Viewport><Scroller><RenderLayer/>… </Scroller></Viewport>`. Forward a `ref` to the scroll/page container DOM node (for snapshot) and expose callbacks: `onSelectionPopup({text, rect, page})`, `onAnnotationsChanged`. Expose imperative handle: `currentPage`, `exportAnnotations()`, `importAnnotations()`, `createHighlightFromSelection()`, `setActiveTool()`.
  - Selection: `useSelection()` from `@embedpdf/plugin-selection/react` → subscribe to selection change, compute bounding rect, surface text+rect+page.
  - Annotation: `useAnnotation()` from `@embedpdf/plugin-annotation/react` → `provides` for `createAnnotation`, `onAnnotationEvent`, `exportAnnotations().wait(...)`, `importAnnotations(...)`, `deleteAnnotation`.
  - **Discovery point:** confirm exact hook return shapes against installed `node_modules/@embedpdf/plugin-*/dist` types; adjust names if the installed version differs from docs.

**Step 2:** In `App.tsx`:
- Lazy import: `const Lectures = lazy(() => import('./routes/Lectures'))`, `const LectureReader = lazy(() => import('./routes/LectureReader'))` (these route files use default exports).
- Wrap routes in `<Suspense fallback={<BootSplash/>}>` (or a lighter spinner).
- Add `<Route path="/lectures" element={<Lectures/>} />` and `<Route path="/lectures/:slug" element={<LectureReader/>} />`.
- Add `<NavItem to="/lectures">講義</NavItem>` as the 7th pill after 錯題 (line ~101).

**Step 3:** `pnpm typecheck` + `pnpm build`; confirm a separate chunk for EmbedPDF exists in `dist/assets` and is not in the entry chunk.

**Step 4:** Commit `feat(fe): EmbedPDF viewer wrapper + lazy /lectures routes + nav pill`.

---

### Task 8: Lectures index page

**Files:** Create `frontend/src/routes/Lectures.tsx`.

**Step 1:** `default export function Lectures()`: fetch `GET /api/lectures`; render scholarly card grid (reuse existing card/typography classes; serif title). Each card: title, instructor, `page_count` 頁, badges for `anno_count`/`note_count`; `<Link to={'/lectures/' + slug}>`. Page `<h1>複習班講義</h1>`. Loading + empty states.

**Step 2:** `pnpm typecheck` PASS. Commit `feat(fe): lectures index page`.

---

### Task 9: LectureReader — toolbar, selection popup, side panel, hooks

**Files:** Create `frontend/src/routes/LectureReader.tsx`, `frontend/src/components/lecture/ReaderToolbar.tsx`, `frontend/src/components/lecture/SelectionPopup.tsx`, `frontend/src/components/lecture/LecturePanel.tsx`, `frontend/src/hooks/useLectureAnnotations.ts`, `frontend/src/hooks/useLectureNotes.ts`.

**Step 1:** Hooks — `useLectureAnnotations(slug)` and `useLectureNotes(slug)`: load on mount, expose `items` + optimistic `create/update/remove` calling `lectureApi`. Annotations: on load, feed stored `payload_json[]` to viewer `importAnnotations`; subscribe to `onAnnotationEvent(create/delete/update + committed)` → persist via API.

**Step 2:** `SelectionPopup.tsx` — absolutely positioned at the selection rect; buttons: Highlight (`viewer.createHighlightFromSelection()` → persists via hook), AI 解釋 (call `lectureApi.explainSelection(text)` → render zh-TW result inline with loading state), OpenEvidence (`window.open(buildOpenEvidenceUrl(...))` adapted to take raw text), 複製到筆記 (call panel callback to append a new note entry tagged with current page).

**Step 3:** `LecturePanel.tsx` — right panel / mobile bottom-sheet; tabs 筆記 / 標註.
- 筆記: page filter `[全部 ▾]`; list note entries (ReadOnlyEditor) with `📄 p.N` tag; "新增筆記" opens `Editor` (shared `buildExtensions()` → `@114-001` works) defaulting `page = currentPage`; edit/delete own entries.
- 標註: list highlights/sticky notes; click → `viewer.scrollToPage(page)`; delete.

**Step 4:** `ReaderToolbar.tsx` — page prev/next + indicator, zoom in/out/fit, 截圖 button, panel toggle. Wire zoom/page to viewer imperative handle.

**Step 5:** `LectureReader.tsx` — fetch `GET /api/lectures/:slug`; layout = toolbar + `<EmbedPDFViewer ref>` (main) + `<LecturePanel>`; manage `currentPage`, selection-popup state, toast. Sticky-note tool: toolbar/long-press adds a `kind:'note'` annotation with a text anchor.

**Step 6:** `pnpm typecheck` + `pnpm build` PASS. Commit `feat(fe): lecture reader — toolbar, selection popup, notebook & annotations`.

---

### Task 10: Snapshot wiring

**Files:** Modify `LectureReader.tsx` / `ReaderToolbar.tsx`.

**Step 1:** Pass the viewer's page-container ref to `截圖`. On click → `snapshotToClipboard(node)`; toast 「已複製到剪貼簿」 (clipboard) or 「已下載截圖」 (download); error toast on throw. Ensure annotation overlay DOM is inside the captured node so highlights/pins render in the PNG.

**Step 2:** Manual verify: highlight something, click 截圖, paste into a doc → image shows slide + highlight. Test fallback by temporarily forcing the download branch.

**Step 3:** Commit `feat(fe): snapshot current slide (with annotations) to clipboard`.

---

### Task 11: Home dashboard card + final verification

**Files:** Modify `frontend/src/routes/Home.tsx`.

**Step 1:** Add a 複習班講義 entry card (mobile reach) linking to `/lectures`, matching existing Home cards.

**Step 2:** Full smoke (local `wrangler dev` + `vite`), as a logged-in dev user:
- Index lists 7 lectures with counts.
- Open a lecture → PDF renders; zoom/page-nav work.
- Select text → popup; Highlight persists (reload → still there); AI 解釋 returns zh-TW; OpenEvidence opens; 複製到筆記 adds a page-tagged note.
- Notebook: add note with `@114-001` → click navigates to `/q/114-001`; page filter works.
- Sticky note add/edit/delete; 標註 list jump-to-page.
- 截圖 → clipboard PNG includes annotations; download fallback works.
- `pnpm typecheck` clean; EmbedPDF in its own lazy chunk.

**Step 3:** Commit `feat(fe): home card for 複習班講義` + a final `docs:` note if anything diverged from the design.

---

## Risks / discovery points
- **EmbedPDF API drift:** doc names (`useAnnotation`, `useSelection`, `createAnnotation`, `exportAnnotations().wait`, `onAnnotationEvent`) must be verified against the *installed* package `dist` types in Task 7; adjust as needed. This is the highest-uncertainty task — do it carefully and incrementally.
- **Access cookie on `/pdf` fetch:** EmbedPDF loader must send same-origin credentials so the CF Access cookie authorizes the byte-range requests. Verify the loader uses `credentials: 'same-origin'` (default for same-origin) — our proxy is same-origin so this should hold.
- **Sticky-note rendering in snapshot:** if EmbedPDF draws annotations to an internal canvas not in the captured DOM subtree, the snapshot may miss them — capture the node that contains both the page canvas and the annotation layer; verify visually in Task 10.

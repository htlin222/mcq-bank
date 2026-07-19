import { useEditor, EditorContent } from '@tiptap/react';
import { useEffect, useRef, useState, useCallback } from 'react';
import { Highlighter, X as XIcon } from 'lucide-react';
import { buildExtensions } from '../lib/tiptap-extensions';
import { readLocal, saveHighlight, reconcileHighlight } from '../lib/highlightStore';

// Read-only content that the reader can personally annotate: select text to add
// a 螢光標記 (highlight), click a mark to clear it, and — when `cloze` is on —
// every mark is covered like a fill-in-the-blank that reveals on click.
//
// The editor is a real ProseMirror instance (editable:false); highlight marks
// are applied by programmatic transactions (allowed even when not editable) and
// the annotated doc is persisted to localStorage under `storeKey` (invalidated
// when the underlying content changes). Nothing touches the server — highlights
// are a private, this-device layer. Cloze reveal state is session-only.

type Props = {
  content: any;
  /** localStorage namespace for this doc's highlights, e.g. `anno:exp:114-001`. */
  storeKey: string;
  /** When true, cover every highlighted span like a cloze blank. */
  cloze?: boolean;
  /**
   * AI-extracted key terms to auto-highlight (verbatim substrings). Applied
   * on top of the reader's own marks, NOT persisted — a reload clears them.
   * Combined with `cloze`, this turns a 詳解 into a fill-in-the-blank test
   * without the reader hand-marking anything.
   */
  autoTerms?: string[];
};

// djb2 — cheap stable fingerprint of the base doc so stale highlights (saved
// against an older version of the text) are dropped instead of masking edits.
// Exported so NoteContent can key each batched section by its content.
export function hashContent(content: any): string {
  const s = JSON.stringify(content ?? '');
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return String(h >>> 0);
}

type Popup =
  | { kind: 'add'; x: number; y: number; from: number; to: number }
  | { kind: 'clear'; x: number; y: number; from: number; to: number }
  | null;

export function AnnotatableContent({ content, storeKey, cloze = false, autoTerms }: Props) {
  const base = content || { type: 'doc', content: [] };
  const editor = useEditor({
    extensions: buildExtensions({ readOnly: true }),
    content: base,
    editable: false,
    editorProps: { attributes: { class: 'tiptap' } },
  });
  const wrapRef = useRef<HTMLDivElement>(null);
  const [popup, setPopup] = useState<Popup>(null);
  const baseHash = hashContent(base);

  // Cloze reveal state: indices (in DOM order) of the marks the reader has
  // un-hidden. Kept in React state (+ sessionStorage, per doc) rather than as a
  // bare DOM class, so a reveal survives re-renders and can be toggled back
  // hidden — a DOM class alone got wiped on repaint, so reveals only stuck once.
  const clozeKey = storeKey + ':cloze';
  const [revealed, setRevealed] = useState<Set<number>>(() => {
    try {
      const raw = sessionStorage.getItem(clozeKey);
      if (raw) return new Set(JSON.parse(raw) as number[]);
    } catch {
      /* ignore */
    }
    return new Set();
  });
  const toggleRevealed = useCallback(
    (idx: number) => {
      setRevealed((prev) => {
        const next = new Set(prev);
        if (next.has(idx)) next.delete(idx);
        else next.add(idx);
        try {
          sessionStorage.setItem(clozeKey, JSON.stringify([...next]));
        } catch {
          /* best-effort */
        }
        return next;
      });
    },
    [clozeKey],
  );

  // Persist the current (annotated) doc; keyed by a hash of the base content so
  // a changed source discards stale marks.
  // Tracks whether the user has edited highlights since this doc mounted, so a
  // slow server reconcile can't clobber their fresh, local-newer changes.
  const dirtyRef = useRef(false);

  const persist = useCallback(() => {
    if (!editor) return;
    // While AI auto-terms are applied, the doc holds ephemeral highlights that
    // must never be saved (they'd resurrect as permanent "manual" marks on
    // reload). Skip persistence entirely for this transient self-test state.
    if (autoTerms && autoTerms.length > 0) return;
    dirtyRef.current = true;
    // Writes localStorage immediately + syncs to the server (fire-and-forget).
    saveHighlight(storeKey, baseHash, editor.getJSON());
  }, [editor, storeKey, baseHash, autoTerms]);

  // Load base content, then re-apply saved highlights if they match this text.
  // localStorage is read synchronously for an instant, flash-free paint.
  useEffect(() => {
    if (!editor) return;
    dirtyRef.current = false;
    const saved = readLocal(storeKey);
    const doc = saved && saved.h === baseHash && saved.doc ? saved.doc : base;
    editor.commands.setContent(doc, false);
    const root = editor.view.dom as HTMLElement;
    wrapTables(root);
    requestAnimationFrame(() => wrapTables(root));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content, editor, storeKey]);

  // Cross-device sync: reconcile with the server after the instant local paint.
  // Only applies a doc when the server holds a NEWER copy (another device);
  // skips if the user already highlighted here (dirty) or auto-cloze is on.
  useEffect(() => {
    if (!editor) return;
    let cancelled = false;
    reconcileHighlight(storeKey, baseHash).then((serverDoc) => {
      if (cancelled || serverDoc == null) return;
      if (dirtyRef.current) return;
      if (autoTerms && autoTerms.length > 0) return;
      editor.commands.setContent(serverDoc, false);
      const root = editor.view.dom as HTMLElement;
      wrapTables(root);
      requestAnimationFrame(() => wrapTables(root));
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content, editor, storeKey]);

  // Auto-highlight AI-extracted terms (verbatim substrings) on top of the
  // loaded doc. Runs after the content-load effect (definition order), so its
  // setContent can't wipe these. Not persisted — ephemeral cloze scaffolding.
  useEffect(() => {
    if (!editor || !autoTerms || autoTerms.length === 0) return;
    const terms = autoTerms.filter((t) => typeof t === 'string' && t.length >= 2);
    if (terms.length === 0) return;
    const ranges: { from: number; to: number }[] = [];
    editor.state.doc.descendants((node, pos) => {
      if (!node.isText || !node.text) return;
      const text = node.text;
      for (const term of terms) {
        let idx = text.indexOf(term);
        while (idx !== -1) {
          ranges.push({ from: pos + idx, to: pos + idx + term.length });
          idx = text.indexOf(term, idx + term.length);
        }
      }
    });
    if (ranges.length === 0) return;
    let chain = editor.chain();
    for (const r of ranges) chain = chain.setTextSelection(r).setHighlight();
    chain.run();
    window.getSelection()?.removeAllRanges();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, autoTerms, content]);

  // Paint the reveal state onto the current marks (index = DOM order). Runs
  // after content loads and on every reveal/cloze toggle, so a repaint can't
  // strand a stale class. When cloze is off, no mark is revealed-styled.
  useEffect(() => {
    if (!editor) return;
    const marks = (editor.view.dom as HTMLElement).querySelectorAll('mark');
    marks.forEach((m, i) =>
      m.classList.toggle('cloze-revealed', cloze && revealed.has(i)),
    );
  }, [editor, cloze, revealed, content]);

  // Selection → "add highlight" popup. Runs on pointer release inside the view.
  useEffect(() => {
    if (!editor) return;
    const dom = editor.view.dom as HTMLElement;
    const onUp = () => {
      if (cloze) return; // no highlighting while self-testing
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
      if (!dom.contains(sel.anchorNode) || !dom.contains(sel.focusNode)) return;
      let from: number, to: number;
      try {
        const a = editor.view.posAtDOM(sel.anchorNode!, sel.anchorOffset);
        const b = editor.view.posAtDOM(sel.focusNode!, sel.focusOffset);
        from = Math.min(a, b);
        to = Math.max(a, b);
      } catch {
        return;
      }
      if (to - from < 1) return;
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      const box = wrapRef.current?.getBoundingClientRect();
      if (!box) return;
      setPopup({
        kind: 'add',
        x: rect.left - box.left + rect.width / 2,
        y: rect.bottom - box.top + 6,
        from,
        to,
      });
    };
    dom.addEventListener('mouseup', onUp);
    dom.addEventListener('touchend', onUp);
    return () => {
      dom.removeEventListener('mouseup', onUp);
      dom.removeEventListener('touchend', onUp);
    };
  }, [editor, cloze]);

  // Click a <mark>: in cloze mode reveal just that blank; otherwise offer to
  // clear the highlight.
  useEffect(() => {
    if (!editor) return;
    const dom = editor.view.dom as HTMLElement;
    const onClick = (e: MouseEvent) => {
      const t = e.target as Node;
      const el = t instanceof Element ? t : t.parentElement;
      const mark = el?.closest('mark');
      if (!mark || !dom.contains(mark)) return;
      if (cloze) {
        e.preventDefault();
        const marks = Array.from(dom.querySelectorAll('mark'));
        const idx = marks.indexOf(mark);
        if (idx >= 0) toggleRevealed(idx);
        return;
      }
      // Map the clicked <mark> element to its ProseMirror range.
      let from: number, to: number;
      try {
        from = editor.view.posAtDOM(mark, 0);
        to = editor.view.posAtDOM(mark, mark.childNodes.length);
      } catch {
        return;
      }
      const box = wrapRef.current?.getBoundingClientRect();
      if (!box) return;
      const rect = mark.getBoundingClientRect();
      setPopup({
        kind: 'clear',
        x: rect.left - box.left + rect.width / 2,
        y: rect.bottom - box.top + 6,
        from: Math.min(from, to),
        to: Math.max(from, to),
      });
    };
    dom.addEventListener('click', onClick);
    return () => dom.removeEventListener('click', onClick);
  }, [editor, cloze, toggleRevealed]);

  // Dismiss the popup on outside click / scroll / Escape.
  useEffect(() => {
    if (!popup) return;
    const close = (e: Event) => {
      if (
        e instanceof MouseEvent &&
        wrapRef.current?.contains(e.target as Node) &&
        (e.target as HTMLElement).closest('[data-anno-popup]')
      )
        return;
      setPopup(null);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setPopup(null);
    document.addEventListener('mousedown', close);
    window.addEventListener('scroll', () => setPopup(null), { once: true });
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', onKey);
    };
  }, [popup]);

  function applyHighlight() {
    if (!editor || popup?.kind !== 'add') return;
    editor
      .chain()
      .setTextSelection({ from: popup.from, to: popup.to })
      .setHighlight()
      .run();
    window.getSelection()?.removeAllRanges();
    persist();
    setPopup(null);
  }

  function clearHighlight() {
    if (!editor || popup?.kind !== 'clear') return;
    editor
      .chain()
      .setTextSelection({ from: popup.from, to: popup.to })
      .unsetHighlight()
      .run();
    persist();
    setPopup(null);
  }

  if (!editor) return null;
  return (
    <div ref={wrapRef} className={'relative' + (cloze ? ' cloze-active' : '')}>
      <EditorContent editor={editor} />
      {popup && (
        <div
          data-anno-popup
          className="absolute z-30 -translate-x-1/2 flex items-center gap-1 rounded-md border border-ink-200 dark:border-ink-700 bg-white dark:bg-ink-800 shadow-paper px-1 py-1"
          style={{ left: popup.x, top: popup.y }}
        >
          {popup.kind === 'add' ? (
            <button
              onClick={applyHighlight}
              className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded text-ink-700 dark:text-ink-200 hover:bg-yellow-100 dark:hover:bg-yellow-400/20"
            >
              <Highlighter size={13} /> 螢光標記
            </button>
          ) : (
            <button
              onClick={clearHighlight}
              className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded text-ink-700 dark:text-ink-200 hover:bg-rose-100 dark:hover:bg-rose-500/20"
            >
              <XIcon size={13} /> 清除標記
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function wrapTables(root: HTMLElement) {
  root.querySelectorAll('table').forEach((table) => {
    const parent = table.parentElement;
    if (!parent || parent.classList.contains('table-scroll')) return;
    const wrap = document.createElement('div');
    wrap.className = 'table-scroll';
    parent.insertBefore(wrap, table);
    wrap.appendChild(table);
  });
}

import { useEditor, EditorContent } from '@tiptap/react';
import { useEffect, useRef, useState, useCallback } from 'react';
import { Highlighter, X as XIcon } from 'lucide-react';
import { buildExtensions } from '../lib/tiptap-extensions';

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

export function AnnotatableContent({ content, storeKey, cloze = false }: Props) {
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

  // Persist the current (annotated) doc; keyed by a hash of the base content so
  // a changed source discards stale marks.
  const persist = useCallback(() => {
    if (!editor) return;
    try {
      localStorage.setItem(
        storeKey,
        JSON.stringify({ h: baseHash, doc: editor.getJSON() }),
      );
    } catch {
      /* quota/availability — highlights are best-effort */
    }
  }, [editor, storeKey, baseHash]);

  // Load base content, then re-apply saved highlights if they match this text.
  useEffect(() => {
    if (!editor) return;
    let doc = base;
    try {
      const raw = localStorage.getItem(storeKey);
      if (raw) {
        const saved = JSON.parse(raw);
        if (saved && saved.h === baseHash && saved.doc) doc = saved.doc;
      }
    } catch {
      /* ignore corrupt cache */
    }
    editor.commands.setContent(doc, false);
    const root = editor.view.dom as HTMLElement;
    wrapTables(root);
    requestAnimationFrame(() => wrapTables(root));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content, editor, storeKey]);

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
      const mark = (e.target as HTMLElement)?.closest('mark');
      if (!mark || !dom.contains(mark)) return;
      if (cloze) {
        mark.classList.toggle('cloze-revealed');
        e.preventDefault();
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
  }, [editor, cloze]);

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

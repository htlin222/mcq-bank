import { useEditor, EditorContent } from '@tiptap/react';
import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { Highlighter, X as XIcon } from 'lucide-react';
import { buildExtensions } from '../lib/tiptap-extensions';
import { normalizeTiptapDoc } from '../lib/tiptap-doc';
import { readLocal, saveHighlight, reconcileHighlight } from '../lib/highlightStore';
import {
  termRanges,
  clozeSig,
  parseRevealState,
  type TextRun,
  type Range,
} from '../lib/autoCloze';

// Read-only content carrying two INDEPENDENT annotation layers:
//
//   1. 個人畫記 — the reader's own 螢光標記. Real Highlight marks inside the
//      document, persisted to localStorage + the server (`highlightStore`).
//      Durable, cross-device, and the only thing a yellow mark ever means.
//   2. 自動挖空 — AI-extracted key terms (`autoTerms`). Rendered as a
//      ProseMirror *decoration* layer, so they never enter the document and
//      therefore can never be persisted as if the reader had marked them.
//      The term list itself is cached server-side, not here.
//
// `cloze` (防劇透) is the orthogonal switch: when on, both layers are covered
// like fill-in-the-blanks and a click reveals one blank. The AI layer only
// renders while 防劇透 is on — turn it off and you are looking at clean text
// with only your own highlights, exactly as if 自動挖空 had never been pressed.

type Props = {
  content: any;
  /** localStorage namespace for this doc's highlights, e.g. `anno:exp:114-001`. */
  storeKey: string;
  /** When true, cover every blank (own highlights + AI terms) for self-testing. */
  cloze?: boolean;
  /** AI-extracted key terms (verbatim substrings). Never persisted. */
  autoTerms?: string[];
  /** Reports how many blanks each layer currently contributes. */
  onCounts?: (counts: { manual: number; auto: number }) => void;
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

// Plugin state for the AI cloze decoration layer: where the blanks are, and
// which of them the reader has already revealed.
type AutoClozeState = { ranges: Range[]; revealed: number[] };

type Popup =
  | { kind: 'add'; x: number; y: number; from: number; to: number }
  | { kind: 'clear'; x: number; y: number; from: number; to: number }
  | null;

export function AnnotatableContent({
  content,
  storeKey,
  cloze = false,
  autoTerms,
  onCounts,
}: Props) {
  // 正規化 snake_case 節點名稱(見 lib/tiptap-doc.ts),否則 schema 會把整份文件
  // 丟掉 —— 詳解就變成一張空白卡片。useMemo 是必要的而非最佳化:`base` 餵給
  // hashContent,而那個 hash 是畫記的儲存 key,每次 render 換新物件會讓下面兩個
  // effect 不停重跑。乾淨的文件(絕大多數)會原樣回來,hash 因此完全不變,既有畫記
  // 不受影響。
  const base = useMemo(
    () => normalizeTiptapDoc(content) || { type: 'doc', content: [] },
    [content],
  );
  const editor = useEditor({
    extensions: buildExtensions({ readOnly: true }),
    content: base,
    editable: false,
    editorProps: { attributes: { class: 'tiptap' } },
  });
  const wrapRef = useRef<HTMLDivElement>(null);
  const [popup, setPopup] = useState<Popup>(null);
  const baseHash = hashContent(base);

  // Bumped whenever something replaces the document wholesale (initial load,
  // cross-device reconcile). The decoration/reveal effects key off it so their
  // positions are recomputed against the doc actually on screen.
  const [docRev, setDocRev] = useState(0);

  // ── reveal state ──
  // Two namespaces, because the two layers have independent blank indices:
  //   `revealed`     — index into the <mark> elements (the reader's own)
  //   `autoRevealed` — index into the AI ranges
  // Persisted per doc in sessionStorage; the auto half is tied to `sig` so a
  // different term list can never inherit stale reveals.
  const clozeKey = storeKey + ':cloze';
  const sig = clozeSig(autoTerms);
  const [revealed, setRevealed] = useState<Set<number>>(new Set());
  const [autoRevealed, setAutoRevealed] = useState<Set<number>>(new Set());
  const revealedRef = useRef(revealed);
  const autoRevealedRef = useRef(autoRevealed);
  revealedRef.current = revealed;
  autoRevealedRef.current = autoRevealed;

  useEffect(() => {
    let raw: string | null = null;
    try {
      raw = sessionStorage.getItem(clozeKey);
    } catch {
      /* unavailable — start clean */
    }
    const st = parseRevealState(raw, sig);
    setRevealed(new Set(st.m));
    setAutoRevealed(new Set(st.a));
  }, [clozeKey, sig]);

  const writeReveal = useCallback(
    (m: Set<number>, a: Set<number>) => {
      try {
        sessionStorage.setItem(clozeKey, JSON.stringify({ m: [...m], a: [...a], sig }));
      } catch {
        /* best-effort */
      }
    },
    [clozeKey, sig],
  );

  const toggleRevealed = useCallback(
    (idx: number) => {
      setRevealed((prev) => {
        const next = toggled(prev, idx);
        writeReveal(next, autoRevealedRef.current);
        return next;
      });
    },
    [writeReveal],
  );

  const toggleAutoRevealed = useCallback(
    (idx: number) => {
      setAutoRevealed((prev) => {
        const next = toggled(prev, idx);
        writeReveal(revealedRef.current, next);
        return next;
      });
    },
    [writeReveal],
  );

  // ── persistence of the reader's own layer ──
  // Tracks whether the user has edited highlights since this doc mounted, so a
  // slow server reconcile can't clobber their fresh, local-newer changes.
  // No auto-cloze interlock here on purpose: the AI layer isn't in the document,
  // so a 畫記 edit made with 自動挖空 on saves like any other.
  const dirtyRef = useRef(false);

  const persist = useCallback(() => {
    if (!editor) return;
    dirtyRef.current = true;
    // Writes localStorage immediately + syncs to the server (fire-and-forget).
    saveHighlight(storeKey, baseHash, editor.getJSON());
  }, [editor, storeKey, baseHash]);

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
    setDocRev((r) => r + 1);
    // Keyed on `baseHash`, NOT on `content`: NoteContent rebuilds its section
    // doc object on every render, so an identity-keyed effect re-ran forever —
    // setContent wiped the selection (killing the 螢光標記 popup before it
    // could appear) and the setDocRev below re-rendered straight back into it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseHash, editor, storeKey]);

  // Cross-device sync: reconcile with the server after the instant local paint.
  // Only applies a doc when the server holds a NEWER copy (another device);
  // skips if the user already highlighted here (dirty).
  useEffect(() => {
    if (!editor) return;
    let cancelled = false;
    reconcileHighlight(storeKey, baseHash).then((serverDoc) => {
      if (cancelled || serverDoc == null) return;
      if (dirtyRef.current) return;
      editor.commands.setContent(serverDoc, false);
      const root = editor.view.dom as HTMLElement;
      wrapTables(root);
      requestAnimationFrame(() => wrapTables(root));
      setDocRev((r) => r + 1);
    });
    return () => {
      cancelled = true;
    };
    // Same reason as above — and identity-keying here also fired one
    // reconcile request per render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseHash, editor, storeKey]);

  // ── AI cloze layer (decorations only) ──
  // One plugin per editor instance; its state is a plain {ranges, revealed}
  // pushed in by the effect below via a meta transaction.
  const keyRef = useRef<PluginKey<AutoClozeState> | null>(null);
  if (!keyRef.current) keyRef.current = new PluginKey<AutoClozeState>('autoCloze');

  useEffect(() => {
    if (!editor) return;
    const key = keyRef.current!;
    const plugin = new Plugin({
      key,
      state: {
        init: (): AutoClozeState => ({ ranges: [], revealed: [] }),
        apply: (tr, value: AutoClozeState): AutoClozeState => tr.getMeta(key) ?? value,
      },
      props: {
        decorations(state) {
          const v: AutoClozeState | undefined = key.getState(state);
          if (!v || v.ranges.length === 0) return null;
          const max = state.doc.content.size;
          const shown = new Set(v.revealed);
          const decos = v.ranges
            .filter((r) => r.from >= 0 && r.to <= max && r.to > r.from)
            .map((r, i) =>
              Decoration.inline(r.from, r.to, {
                class: 'cloze-auto' + (shown.has(i) ? ' cloze-revealed' : ''),
                'data-cloze-auto': String(i),
              }),
            );
          return DecorationSet.create(state.doc, decos);
        },
      },
    });
    editor.registerPlugin(plugin);
    return () => {
      editor.unregisterPlugin(key);
    };
  }, [editor]);

  // Recompute the AI ranges against the live doc and push them + reveal state
  // into the plugin. `cloze` gates the whole layer: 防劇透 off ⇒ zero ranges ⇒
  // no decorations at all, so the AI layer is genuinely invisible, not just
  // un-styled.
  const onCountsRef = useRef(onCounts);
  onCountsRef.current = onCounts;
  useEffect(() => {
    if (!editor) return;
    const active = cloze && !!autoTerms && autoTerms.length > 0;
    const ranges = active ? termRanges(collectRuns(editor.state.doc), autoTerms!) : [];
    const tr = editor.state.tr.setMeta(keyRef.current!, {
      ranges,
      revealed: [...autoRevealed],
    });
    tr.setMeta('addToHistory', false);
    editor.view.dispatch(tr);
    const manual = (editor.view.dom as HTMLElement).querySelectorAll('mark').length;
    onCountsRef.current?.({ manual, auto: ranges.length });
  }, [editor, cloze, autoTerms, autoRevealed, docRev]);

  // Paint the reveal state onto the reader's own marks (index = DOM order).
  // Runs after content loads and on every reveal/cloze toggle, so a repaint
  // can't strand a stale class. When cloze is off, no mark is revealed-styled.
  useEffect(() => {
    if (!editor) return;
    const marks = (editor.view.dom as HTMLElement).querySelectorAll('mark');
    marks.forEach((m, i) => m.classList.toggle('cloze-revealed', cloze && revealed.has(i)));
  }, [editor, cloze, revealed, docRev]);

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

  // Click inside the view. In cloze mode a click reveals exactly one blank —
  // an AI blank if the click landed in one (checked first, since an AI term can
  // sit inside a highlighted span), otherwise the reader's own mark. Outside
  // cloze mode, clicking a mark offers to clear it.
  useEffect(() => {
    if (!editor) return;
    const dom = editor.view.dom as HTMLElement;
    const onClick = (e: MouseEvent) => {
      const t = e.target as Node;
      const el = t instanceof Element ? t : t.parentElement;

      if (cloze) {
        const auto = el?.closest('[data-cloze-auto]');
        if (auto && dom.contains(auto)) {
          e.preventDefault();
          const idx = Number(auto.getAttribute('data-cloze-auto'));
          if (Number.isInteger(idx)) toggleAutoRevealed(idx);
          return;
        }
      }

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
  }, [editor, cloze, toggleRevealed, toggleAutoRevealed]);

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
    editor.chain().setTextSelection({ from: popup.from, to: popup.to }).setHighlight().run();
    window.getSelection()?.removeAllRanges();
    persist();
    setPopup(null);
  }

  function clearHighlight() {
    if (!editor || popup?.kind !== 'clear') return;
    editor.chain().setTextSelection({ from: popup.from, to: popup.to }).unsetHighlight().run();
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

function toggled(prev: Set<number>, idx: number): Set<number> {
  const next = new Set(prev);
  if (next.has(idx)) next.delete(idx);
  else next.add(idx);
  return next;
}

function collectRuns(doc: any): TextRun[] {
  const runs: TextRun[] = [];
  doc.descendants((node: any, pos: number) => {
    if (node.isText && node.text) runs.push({ pos, text: node.text });
  });
  return runs;
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
